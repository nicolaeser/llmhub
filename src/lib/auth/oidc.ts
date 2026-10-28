import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { pkceChallenge, signingSecret } from "@/lib/crypto";
import { env } from "@/lib/env";
import { asRecord, asString, asStringArray } from "@/lib/gateway/core";
import {
  APP_ROLES_SCOPE,
  DEFAULT_OIDC_SCOPES,
  ENTRA_TENANT_ID,
  issuerHasPlaceholder,
  issuerHost,
  oidcScopes,
  trimIssuer,
} from "@/lib/auth/oidc-presets";
import { verifyJwt } from "@/lib/auth/jwks";
import { parseJsonOrNull, readJsonOr } from "@/lib/utils/json";
import type { LogMeta } from "@/types/logging";
import type {
  OidcDiscoveryCache,
  OidcDiscovery,
  OidcDiscoveryFailure,
  OidcDiscoveryFailureDetail,
  OidcEnv,
  OidcState,
  OidcStatePurpose,
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
const STATE_PURPOSES: readonly OidcStatePurpose[] = ["sign_in", "role_check"];
const OIDC_STATE_TTL_SECONDS = 600;
const STATE_PART = /^[A-Za-z0-9_-]{16,128}$/;
const ENTRA_V2_ISSUER = /^https:\/\/login\.microsoftonline\.com\/([^/?#]+)\/v2\.0$/i;
const ENTRA_SHARED_TENANTS = new Set(["common", "organizations", "consumers"]);
let discCache: OidcDiscoveryCache | null = null;

export class OidcDiscoveryError extends Error {
  readonly status?: number;
  readonly issuer?: string;

  constructor(
    readonly reason: OidcDiscoveryFailure,
    detail: OidcDiscoveryFailureDetail = {},
  ) {
    super(`oidc discovery ${reason}`);
    this.name = "OidcDiscoveryError";
    this.status = detail.status;
    this.issuer = detail.issuer;
  }
}

export function oidcFailureFields(err: unknown): LogMeta {
  if (!(err instanceof OidcDiscoveryError)) return {};
  return {
    reason: err.reason,
    ...(err.status ? { status: err.status } : {}),
    ...(err.issuer ? { issuerHost: issuerHost(err.issuer) } : {}),
  };
}

export function entraTenantIdIssuer(configured: string, discovered: string): boolean {
  const tenant = ENTRA_V2_ISSUER.exec(configured)?.[1] ?? "";
  const tenantId = ENTRA_V2_ISSUER.exec(discovered)?.[1] ?? "";
  return (
    Boolean(tenant) &&
    !ENTRA_TENANT_ID.test(tenant) &&
    !ENTRA_SHARED_TENANTS.has(tenant.toLowerCase()) &&
    ENTRA_TENANT_ID.test(tenantId)
  );
}

function assertDiscoveredIssuer(configured: string, discovered: string): void {
  if (issuerHasPlaceholder(discovered)) {
    throw new OidcDiscoveryError("multi_tenant", { issuer: discovered });
  }
  const trimmed = trimIssuer(discovered);
  if (trimmed === configured || entraTenantIdIssuer(configured, trimmed)) return;
  throw new OidcDiscoveryError("issuer_mismatch", { issuer: discovered });
}

async function discoveryDocument(url: string, fetchFn: typeof fetch): Promise<Record<string, unknown>> {
  const unreachable = () => {
    throw new OidcDiscoveryError("unreachable");
  };
  const res = await fetchFn(url, { signal: AbortSignal.timeout(8_000) }).catch(unreachable);
  if (!res.ok) throw new OidcDiscoveryError("http", { status: res.status });
  const rec = asRecord(parseJsonOrNull(await res.text().catch(unreachable)));
  if (!rec) throw new OidcDiscoveryError("not_json");
  return rec;
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
  const rec = await discoveryDocument(`${trimmed}/.well-known/openid-configuration`, fetchFn);
  const disc: OidcDiscovery = {
    issuer: asString(rec.issuer, trimmed),
    authorization_endpoint: asString(rec.authorization_endpoint),
    token_endpoint: asString(rec.token_endpoint),
    jwks_uri: asString(rec.jwks_uri),
    userinfo_endpoint: asString(rec.userinfo_endpoint),
    scopes_supported: asStringArray(rec.scopes_supported),
    token_endpoint_auth_methods_supported: asStringArray(rec.token_endpoint_auth_methods_supported),
    id_token_signing_alg_values_supported: asStringArray(rec.id_token_signing_alg_values_supported),
  };
  assertDiscoveredIssuer(trimmed, disc.issuer);
  if (!disc.authorization_endpoint || !disc.token_endpoint || !disc.jwks_uri) {
    throw new OidcDiscoveryError("incomplete");
  }
  discCache = { issuer: trimmed, disc, fetched: Date.now() };
  return disc;
}

export function appRolesOffered(disc: Pick<OidcDiscovery, "scopes_supported">): boolean {
  return disc.scopes_supported.includes(APP_ROLES_SCOPE);
}

function authorizationScopes(disc: Pick<OidcDiscovery, "scopes_supported">, resolved: ResolvedOidc): string {
  const configured = resolved.scopes.split(" ").filter((scope) => scope !== APP_ROLES_SCOPE);
  return oidcScopes([...configured, ...(appRolesOffered(disc) ? [APP_ROLES_SCOPE] : [])].join(" "));
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
    scope: authorizationScopes(disc, resolved),
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
  purpose?: OidcStatePurpose;
}): OidcState {
  const state = input.state ?? randomPart();
  const nonce = input.nonce ?? randomPart();
  const verifier = input.verifier ?? randomPart();
  const iat = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const returnPath = input.returnPath ?? "";
  const payload = `${state}.${nonce}.${verifier}.${iat}.${b64url(returnPath)}.${input.purpose ?? "sign_in"}`;
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
  if (parts.length !== 7) return null;
  const [state, nonce, verifier, iatRaw, returnB64, purposeRaw, sig] = parts;
  if (![state, nonce, verifier].every((part) => STATE_PART.test(part))) return null;
  if (!iatRaw || returnB64 == null || !sig) return null;
  const payload = `${state}.${nonce}.${verifier}.${iatRaw}.${returnB64}.${purposeRaw}`;
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
  const purpose = STATE_PURPOSES.find((value) => value === purposeRaw);
  if (returnPath == null || !purpose) return null;
  return { nonce, verifier, returnPath, purpose };
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

export function appRolesFromClaims(claims: JwtClaims): string[] | null {
  if (!Array.isArray(claims[APP_ROLES_SCOPE])) return null;
  return [...new Set(claimValues(claims, APP_ROLES_SCOPE).map((value) => value.toLowerCase()))];
}

export function identityFromClaims(claims: JwtClaims, groupsClaim: string, appRoles = false): OidcIdentity {
  const subject = typeof claims.sub === "string" ? claims.sub.trim() : "";
  if (!subject) throw new Error("oidc token missing sub");
  const oid = typeof claims.oid === "string" ? claims.oid.trim() : "";
  return {
    issuer: String(claims.iss ?? ""),
    subject,
    email: emailFromOidcClaims(claims),
    groups: claimValues(claims, groupsClaim),
    appRoles: appRoles ? appRolesFromClaims(claims) : null,
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

function tokenFailureMessage(status: number, rec: Record<string, unknown>): string {
  const codes = Array.isArray(rec.error_codes) ? rec.error_codes.filter((code) => Number.isInteger(code)) : [];
  const providerCodes = codes.slice(0, 3).map((code) => `AADSTS${code}`).join(",");
  return ["oidc token", String(status), asString(rec.error).slice(0, 80), providerCodes].filter(Boolean).join(" ");
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
  if (!idToken) throw new Error(tokenFailureMessage(res.status, rec));
  const claims = await verifyJwt(idToken, jwtConfigForOidc(input.resolved, disc));
  if (claims.nonce !== input.nonce) throw new Error("oidc nonce mismatch");
  return identityFromClaims(claims, input.resolved.groupsClaim, appRolesOffered(disc));
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
