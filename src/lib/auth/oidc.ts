import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { pkceChallenge, signingSecret } from "@/lib/crypto";
import { env } from "@/lib/env";
import { asRecord, asString, asStringArray } from "@/lib/gateway/core";
import { DEFAULT_OIDC_SCOPES, oidcScopes } from "@/lib/auth/oidc-presets";
import { verifyJwt } from "@/lib/auth/jwks";
import { readJsonOr } from "@/lib/utils/json";
import type {
  OidcDiscoveryCache,
  OidcDiscovery,
  OidcEnv,
  OidcState,
  ResolvedOidc,
  VerifiedOidcState,
  JwtClaims,
  JwtConfig,
  OidcIdentity,
  OidcSettings,
  OidcTokenAuth,
} from "@/types/auth";

export const OIDC_STATE_COOKIE =
  process.env.NODE_ENV === "production" ? "__Host-llmhub-oidc" : "llmhub_oidc";
const OIDC_STATE_TTL_SECONDS = 600;
const STATE_PART = /^[A-Za-z0-9_-]{16,128}$/;
let discCache: OidcDiscoveryCache | null = null;

export function trimIssuer(issuer: string): string {
  return issuer.trim().replace(/\/+$/, "");
}

export function oidcCallbackUrl(appUrl: string = env.NEXT_PUBLIC_APP_URL): string {
  return `${appUrl.replace(/\/+$/, "")}/sso/callback`;
}

export function resolveOidc(
  cfg: Partial<OidcSettings> | undefined,
  envOverride: OidcEnv = {},
): ResolvedOidc {
  const clientSecret = envOverride.clientSecret ?? env.OIDC_CLIENT_SECRET ?? "";
  return {
    enabled: Boolean(cfg?.enabled),
    issuer: trimIssuer(cfg?.issuer ?? ""),
    clientId: (cfg?.client_id ?? "").trim(),
    clientSecret: clientSecret.trim(),
    redirectUrl: oidcCallbackUrl(envOverride.appUrl ?? env.NEXT_PUBLIC_APP_URL),
    scopes: oidcScopes(cfg?.scopes ?? DEFAULT_OIDC_SCOPES),
    groupsClaim: (cfg?.groups_claim ?? "").trim(),
  };
}

export function oidcIsReady(
  cfg: Partial<OidcSettings> | undefined,
  envOverride: OidcEnv = {},
): boolean {
  const resolved = resolveOidc(cfg, envOverride);
  return (
    resolved.enabled &&
    Boolean(resolved.issuer) &&
    Boolean(resolved.clientId) &&
    Boolean(resolved.clientSecret)
  );
}

export function ssoOnlyActive(
  cfg: Partial<OidcSettings> | undefined,
  envOverride: OidcEnv = {},
): boolean {
  return cfg?.sso_only === true && oidcIsReady(cfg, envOverride);
}

export function resetOidcCache(): void {
  discCache = null;
}

export async function fetchOidcDiscovery(
  issuer: string,
  fetchFn: typeof fetch = fetch,
): Promise<OidcDiscovery> {
  const trimmed = trimIssuer(issuer);
  if (!trimmed) throw new Error("oidc issuer missing");
  if (
    discCache &&
    discCache.issuer === trimmed &&
    Date.now() - discCache.fetched < 300_000
  ) {
    return discCache.disc;
  }
  const url = `${trimmed}/.well-known/openid-configuration`;
  const res = await fetchFn(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`oidc discovery ${res.status}`);
  const rec = asRecord(await res.json()) ?? {};
  const disc: OidcDiscovery = {
    issuer: asString(rec.issuer, trimmed),
    authorization_endpoint: asString(rec.authorization_endpoint),
    token_endpoint: asString(rec.token_endpoint),
    jwks_uri: asString(rec.jwks_uri),
    userinfo_endpoint: asString(rec.userinfo_endpoint),
    token_endpoint_auth_methods_supported: asStringArray(rec.token_endpoint_auth_methods_supported),
    id_token_signing_alg_values_supported: asStringArray(rec.id_token_signing_alg_values_supported),
  };
  if (trimIssuer(disc.issuer) !== trimmed) {
    throw new Error("oidc discovery issuer mismatch");
  }
  if (!disc.authorization_endpoint) {
    throw new Error("oidc discovery missing authorization_endpoint");
  }
  if (!disc.token_endpoint) {
    throw new Error("oidc discovery missing token_endpoint");
  }
  if (!disc.jwks_uri) {
    throw new Error("oidc discovery missing jwks_uri");
  }
  discCache = { issuer: trimmed, disc, fetched: Date.now() };
  return disc;
}

export function buildAuthorizationUrl(
  disc: OidcDiscovery,
  resolved: ResolvedOidc,
  state: Pick<OidcState, "state" | "nonce" | "codeChallenge">,
): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: resolved.clientId,
    redirect_uri: resolved.redirectUrl,
    scope: resolved.scopes,
    state: state.state,
    nonce: state.nonce,
    code_challenge: state.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${disc.authorization_endpoint}?${q.toString()}`;
}

export function tokenAuthMethod(supported: readonly string[]): OidcTokenAuth {
  const basic = supported.indexOf("client_secret_basic");
  const post = supported.indexOf("client_secret_post");
  if (basic === -1) return "client_secret_post";
  if (post === -1 || basic < post) return "client_secret_basic";
  return "client_secret_post";
}

function formEncode(value: string): string {
  return new URLSearchParams({ v: value }).toString().slice(2);
}

export function tokenRequest(
  resolved: ResolvedOidc,
  code: string,
  verifier: string,
  method: OidcTokenAuth = "client_secret_post",
): { headers: Record<string, string>; body: URLSearchParams } {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: resolved.redirectUrl,
    code_verifier: verifier,
  });
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
  if (method === "client_secret_basic") {
    const credentials = `${formEncode(resolved.clientId)}:${formEncode(resolved.clientSecret)}`;
    headers.Authorization = `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;
  } else {
    body.set("client_id", resolved.clientId);
    body.set("client_secret", resolved.clientSecret);
  }
  return { headers, body };
}

function hmacHex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function b64url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(value: string): string | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return null;
  }
}

const randomPart = () => randomBytes(32).toString("base64url");

export function signOidcState(input: {
  returnPath?: string;
  state?: string;
  nonce?: string;
  verifier?: string;
  nowSeconds?: number;
  secret?: string;
}): OidcState {
  const state = input.state ?? randomPart();
  const nonce = input.nonce ?? randomPart();
  const verifier = input.verifier ?? randomPart();
  const iat = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const returnPath = input.returnPath ?? "";
  const payload = `${state}.${nonce}.${verifier}.${iat}.${b64url(returnPath)}`;
  const cookie = `${payload}.${hmacHex(input.secret ?? signingSecret(), `oidc:${payload}`)}`;
  return { state, nonce, verifier, codeChallenge: pkceChallenge(verifier), returnPath, cookie };
}

export function verifyOidcState(input: {
  cookie: string;
  state: string;
  nowSeconds?: number;
  secret?: string;
}): VerifiedOidcState | null {
  const parts = input.cookie.split(".");
  if (parts.length !== 6) return null;
  const [state, nonce, verifier, iatRaw, returnB64, sig] = parts;
  if (![state, nonce, verifier].every((part) => STATE_PART.test(part))) return null;
  if (!iatRaw || returnB64 == null || !sig) return null;
  const payload = `${state}.${nonce}.${verifier}.${iatRaw}.${returnB64}`;
  const expected = hmacHex(input.secret ?? signingSecret(), `oidc:${payload}`);
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const given = Buffer.from(input.state, "utf8");
  const stored = Buffer.from(state, "utf8");
  if (given.length !== stored.length || !timingSafeEqual(given, stored)) return null;
  const iat = Number(iatRaw);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(iat) || now - iat > OIDC_STATE_TTL_SECONDS || iat > now + 60) {
    return null;
  }
  const returnPath = b64urlDecode(returnB64);
  if (returnPath == null) return null;
  return { nonce, verifier, returnPath };
}

const MAX_CLAIM_VALUES = 500;

function isTrue(value: unknown): boolean {
  return value === true || value === "true" || value === 1;
}

export function emailFromOidcClaims(claims: JwtClaims): string {
  const verified = isTrue(claims.email_verified) || isTrue(claims.xms_edov);
  if (!verified || typeof claims.email !== "string") return "";
  return claims.email.trim().toLowerCase();
}

export function claimValues(claims: JwtClaims, name: string): string[] {
  const key = name.trim();
  if (!key) return [];
  const value = Object.hasOwn(claims, key)
    ? claims[key]
    : key.split(".").reduce<unknown>((node, part) => asRecord(node)?.[part], claims);
  const list = Array.isArray(value) ? value : [value];
  return list
    .flatMap((item) => (typeof item === "string" || typeof item === "number" ? [String(item).trim()] : []))
    .filter((item) => item && item.length <= 256)
    .slice(0, MAX_CLAIM_VALUES);
}

export function identityFromClaims(claims: JwtClaims, groupsClaim: string): OidcIdentity {
  const subject = typeof claims.sub === "string" ? claims.sub.trim() : "";
  if (!subject) throw new Error("oidc token missing sub");
  const oid = typeof claims.oid === "string" ? claims.oid.trim() : "";
  return {
    issuer: String(claims.iss ?? ""),
    subject,
    email: emailFromOidcClaims(claims),
    groups: claimValues(claims, groupsClaim),
    externalIds: [...new Set([subject, oid].filter(Boolean))],
  };
}

export function jwtConfigForOidc(
  resolved: ResolvedOidc,
  disc: OidcDiscovery,
): JwtConfig {
  return {
    issuer: disc.issuer || resolved.issuer,
    audience: resolved.clientId,
    jwks_url: disc.jwks_uri,
  };
}

export async function exchangeOidcCode(input: {
  resolved: ResolvedOidc;
  code: string;
  nonce: string;
  verifier: string;
  fetchFn?: typeof fetch;
}): Promise<OidcIdentity> {
  const fetchFn = input.fetchFn ?? fetch;
  const disc = await fetchOidcDiscovery(input.resolved.issuer, fetchFn);
  const request = tokenRequest(
    input.resolved,
    input.code,
    input.verifier,
    tokenAuthMethod(disc.token_endpoint_auth_methods_supported),
  );
  const res = await fetchFn(disc.token_endpoint, {
    method: "POST",
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(8_000),
  });
  const rec = asRecord(await readJsonOr(res, null)) ?? {};
  const idToken = asString(rec.id_token);
  if (!idToken) {
    throw new Error(`oidc token ${res.status} ${asString(rec.error).slice(0, 80)}`.trim());
  }
  const claims = await verifyJwt(idToken, jwtConfigForOidc(input.resolved, disc));
  if (claims.nonce !== input.nonce) throw new Error("oidc nonce mismatch");
  return identityFromClaims(claims, input.resolved.groupsClaim);
}

export function oidcStateCookieOptions(maxAge = OIDC_STATE_TTL_SECONDS) {
  return {
    name: OIDC_STATE_COOKIE,
    maxAge,
    path: "/",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
  };
}
