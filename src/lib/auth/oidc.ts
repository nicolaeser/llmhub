import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { signingSecret } from "@/lib/crypto";
import { env } from "@/lib/env";
import { asRecord, asString } from "@/lib/gateway/core";
import { verifyJwt } from "@/lib/gateway/jwks";
import type {
  DiscCache,
  OidcDiscovery,
  OidcEnv,
  OidcState,
  ResolvedOidc,
  VerifiedOidcState,
} from "@/types/auth";
import type { JwtClaims, JWTConfig, OIDCConfig } from "@/types/gateway";

export const OIDC_STATE_COOKIE =
  process.env.NODE_ENV === "production" ? "__Host-llmhub-oidc" : "llmhub_oidc";
const OIDC_STATE_TTL_SECONDS = 600;
const STATE_PART = /^[A-Za-z0-9_-]{16,128}$/;
let discCache: DiscCache | null = null;

export function trimIssuer(issuer: string): string {
  return issuer.trim().replace(/\/+$/, "");
}

export function resolveOidc(
  cfg: OIDCConfig | undefined,
  envOverride: OidcEnv = {},
): ResolvedOidc {
  const appUrl = (envOverride.appUrl ?? env.NEXT_PUBLIC_APP_URL).replace(/\/+$/, "");
  const clientId = cfg?.client_id ?? "";
  const clientSecret = envOverride.clientSecret ?? env.OIDC_CLIENT_SECRET ?? "";
  const redirectUrl =
    (cfg?.redirect_url ?? "").trim() || `${appUrl}/sso/callback`;
  return {
    enabled: Boolean(cfg?.enabled),
    issuer: trimIssuer(cfg?.issuer ?? ""),
    clientId: clientId.trim(),
    clientSecret: clientSecret.trim(),
    redirectUrl,
  };
}

export function oidcIsReady(
  cfg: OIDCConfig | undefined,
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
    issuer: trimIssuer(asString(rec.issuer, trimmed)),
    authorization_endpoint: asString(rec.authorization_endpoint),
    token_endpoint: asString(rec.token_endpoint),
    jwks_uri: asString(rec.jwks_uri),
    userinfo_endpoint: asString(rec.userinfo_endpoint),
  };
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

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
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
    scope: "openid email profile",
    state: state.state,
    nonce: state.nonce,
    code_challenge: state.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${disc.authorization_endpoint}?${q.toString()}`;
}

export function tokenRequestBody(
  resolved: ResolvedOidc,
  code: string,
  verifier: string,
): URLSearchParams {
  return new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: resolved.redirectUrl,
    client_id: resolved.clientId,
    client_secret: resolved.clientSecret,
    code_verifier: verifier,
  });
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

export function emailFromOidcClaims(claims: JwtClaims): string {
  const verified = claims.email_verified === true || claims.email_verified === "true";
  if (!verified || typeof claims.email !== "string") return "";
  return claims.email.trim().toLowerCase();
}

export function jwtConfigForOidc(
  resolved: ResolvedOidc,
  disc: OidcDiscovery,
): JWTConfig {
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
}): Promise<string> {
  const fetchFn = input.fetchFn ?? fetch;
  const disc = await fetchOidcDiscovery(input.resolved.issuer, fetchFn);
  const res = await fetchFn(disc.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenRequestBody(input.resolved, input.code, input.verifier),
    signal: AbortSignal.timeout(8_000),
  });
  const rec = asRecord(await res.json().catch(() => null)) ?? {};
  const idToken = asString(rec.id_token);
  if (!idToken) {
    const detail = asString(rec.error_description) || asString(rec.error) || `oidc token ${res.status}`;
    throw new Error(detail);
  }
  const claims = await verifyJwt(idToken, jwtConfigForOidc(input.resolved, disc));
  if (claims.nonce !== input.nonce) throw new Error("oidc nonce mismatch");
  const email = emailFromOidcClaims(claims);
  if (!email.includes("@")) throw new Error("oidc token missing verified email");
  return email;
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
