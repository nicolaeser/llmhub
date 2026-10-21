import "server-only";
import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { open, seal } from "@/lib/crypto";
import { asNumber, asRecord, asString } from "@/lib/gateway/core";
import { GateError } from "@/lib/gateway/errors";
import { GOOGLE_KEY_HEADER } from "@/lib/gateway/upstreams/google";
import {
  MAX_VERTEX_CREDENTIAL_CHARS,
  VERTEX_DEFAULT_LOCATION,
  VERTEX_EXPRESS_BASE_URL,
  validVertexLocation,
  validVertexProject,
  vertexBaseUrl,
  vertexTarget,
} from "@/lib/gateway/upstreams/vertex-target";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { parseJsonOrNull, readJsonOr } from "@/lib/utils/json";
import type {
  GoogleAccessToken,
  ServiceAccount,
  UpstreamAuth,
  VertexConnectionInput,
  VertexCredential,
  VertexView,
} from "@/types/providers";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const ASSERTION_LIFETIME_S = 3600;
const DEFAULT_TOKEN_LIFETIME_S = 3600;
const REFRESH_MARGIN_MS = 5 * 60_000;
const TOKEN_TIMEOUT_MS = 30_000;
const PEM_BLOCK = /-----BEGIN ((?:RSA )?PRIVATE KEY)-----([\s\S]*?)-----END \1-----/;
const API_KEY = /^[A-Za-z0-9._-]{20,256}$/;
const REJECTED_GRANT_STATUSES = new Set([400, 401, 403]);

const tokens = new Map<string, GoogleAccessToken & { sealed: string }>();
const pending = new Map<string, { sealed: string; promise: Promise<GoogleAccessToken> }>();

function invalidAccount(): Error {
  return new Error("VERTEX_SERVICE_ACCOUNT_INVALID");
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function rebuiltPem(raw: string): string | null {
  const block = PEM_BLOCK.exec(raw);
  if (!block) return null;
  const body = block[2]!.replace(/\\n/g, "").replace(/[^A-Za-z0-9+/=]/g, "");
  if (!body) return null;
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${block[1]}-----\n${lines.join("\n")}\n-----END ${block[1]}-----\n`;
}

function rsaKey(pem: string): KeyObject | null {
  try {
    const key = createPrivateKey(pem);
    return key.asymmetricKeyType === "rsa" ? key : null;
  } catch {
    return null;
  }
}

export function normalizePrivateKey(raw: string): string {
  const text = raw.replace(/\r\n?/g, "\n").replace(/\\n/g, "\n").trim();
  const key = rsaKey(text) ?? rsaKey(rebuiltPem(text) ?? "");
  if (!key) throw invalidAccount();
  return String(key.export({ type: "pkcs8", format: "pem" }));
}

function serviceAccountOf(json: Record<string, unknown>): ServiceAccount {
  const type = asString(json.type);
  if (type && type !== "service_account") throw invalidAccount();
  const email = asString(json.client_email).trim();
  const privateKey = asString(json.private_key);
  if (!email.includes("@") || !privateKey) throw invalidAccount();
  return {
    type: "service_account",
    project_id: asString(json.project_id).trim(),
    private_key_id: asString(json.private_key_id).trim(),
    private_key: normalizePrivateKey(privateKey),
    client_email: email,
    client_id: asString(json.client_id).trim(),
  };
}

export function parseVertexCredential(raw: string): VertexCredential {
  const text = raw.trim();
  if (!text || text.length > MAX_VERTEX_CREDENTIAL_CHARS) throw invalidAccount();
  if (!text.startsWith("{")) {
    if (!API_KEY.test(text)) throw invalidAccount();
    return { type: "api_key", key: text };
  }
  const json = asRecord(parseJsonOrNull(text));
  if (!json) throw invalidAccount();
  return { type: "service_account", account: serviceAccountOf(json) };
}

function storedCredential(credential: VertexCredential): string {
  return credential.type === "api_key" ? credential.key : JSON.stringify(credential.account);
}

function targetProject(input: VertexConnectionInput, credential: VertexCredential | null): string {
  return (
    input.target?.project?.trim() ||
    vertexTarget(input.baseUrl ?? "")?.project ||
    (credential?.type === "service_account" ? credential.account.project_id : "") ||
    vertexTarget(input.currentBaseUrl ?? "")?.project ||
    ""
  );
}

function targetLocation(input: VertexConnectionInput): string {
  return (
    input.target?.location?.trim() ||
    vertexTarget(input.baseUrl ?? "")?.location ||
    vertexTarget(input.currentBaseUrl ?? "")?.location ||
    VERTEX_DEFAULT_LOCATION
  );
}

export function vertexConnection(input: VertexConnectionInput): { apiKey: string; baseUrl: string } {
  const credential = input.credential.trim() ? parseVertexCredential(input.credential) : null;
  if (!credential && !input.currentBaseUrl) throw new Error("VERTEX_CREDENTIAL_REQUIRED");
  const serviceAccount = credential ? credential.type === "service_account" : vertexTarget(input.currentBaseUrl ?? "") !== null;
  const apiKey = credential ? seal(storedCredential(credential)) : "";
  if (!serviceAccount) return { apiKey, baseUrl: VERTEX_EXPRESS_BASE_URL };
  const project = targetProject(input, credential);
  const location = targetLocation(input);
  if (!validVertexProject(project)) throw new Error("VERTEX_PROJECT_INVALID");
  if (!validVertexLocation(location)) throw new Error("VERTEX_LOCATION_INVALID");
  return { apiKey, baseUrl: vertexBaseUrl({ project, location }) };
}

export function serviceAccountAssertion(account: ServiceAccount, now = Date.now()): string {
  const issued = Math.floor(now / 1000);
  const header = { alg: "RS256", typ: "JWT", ...(account.private_key_id ? { kid: account.private_key_id } : {}) };
  const claims = {
    iss: account.client_email,
    scope: CLOUD_PLATFORM_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: issued,
    exp: issued + ASSERTION_LIFETIME_S,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(account.private_key);
  return `${signingInput}.${base64url(signature)}`;
}

function tokenError(status: number, json: unknown): GateError {
  const code = asString(asRecord(json)?.error);
  if (REJECTED_GRANT_STATUSES.has(status)) {
    return new GateError(503, "no_provider_key", `Google rejected the Vertex AI service account${code ? ` (${code})` : ""}`);
  }
  return new GateError(502, "upstream_error", `Google's token endpoint returned ${status}`);
}

export async function exchangeServiceAccount(account: ServiceAccount, now = Date.now()): Promise<GoogleAccessToken> {
  const body = new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion: serviceAccountAssertion(account, now) });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  }).catch((err: unknown) => {
    logger.warn("provider.vertex_token_unreachable", errorFields(err));
    throw new GateError(502, "upstream_error", "Google's token endpoint could not be reached");
  });
  const json = await readJsonOr(res, {});
  const token = asString(asRecord(json)?.access_token);
  if (!res.ok || !token) {
    logger.warn("provider.vertex_token_failed", { status: res.status, code: asString(asRecord(json)?.error) });
    throw tokenError(res.ok ? 502 : res.status, json);
  }
  const lifetime = asNumber(asRecord(json)?.expires_in, DEFAULT_TOKEN_LIFETIME_S);
  return { token, expiresAt: now + Math.max(60, lifetime) * 1000 };
}

function stillFresh(token: GoogleAccessToken, now: number): boolean {
  return token.expiresAt - now > REFRESH_MARGIN_MS;
}

export async function vertexAccessToken(
  providerId: string,
  sealed: string,
  account: ServiceAccount,
  now = Date.now(),
): Promise<string> {
  const cached = tokens.get(providerId);
  if (cached && cached.sealed === sealed && stillFresh(cached, now)) return cached.token;
  const running = pending.get(providerId);
  if (running && running.sealed === sealed) return (await running.promise).token;
  const promise = exchangeServiceAccount(account, now);
  pending.set(providerId, { sealed, promise });
  try {
    const minted = await promise;
    tokens.set(providerId, { ...minted, sealed });
    return minted.token;
  } finally {
    if (pending.get(providerId)?.promise === promise) pending.delete(providerId);
  }
}

export function forgetVertexToken(providerId: string): void {
  tokens.delete(providerId);
  pending.delete(providerId);
}

function serviceAccountEmail(provider: { id: string; apiKey: string }): string {
  try {
    const credential = parseVertexCredential(open(provider.apiKey));
    return credential.type === "service_account" ? credential.account.client_email : "";
  } catch (err) {
    logger.warn("provider.vertex_credential_unreadable", { providerId: provider.id, ...errorFields(err) });
    return "";
  }
}

export function vertexView(provider: { id: string; apiKey: string; baseUrl: string }): VertexView {
  const target = vertexTarget(provider.baseUrl);
  const account = target && provider.apiKey ? serviceAccountEmail(provider) : "";
  return {
    credential: target ? "service_account" : "api_key",
    account,
    project: target?.project ?? "",
    location: target?.location ?? "",
  };
}

export async function vertexAuth(provider: { id: string; apiKey: string }): Promise<UpstreamAuth> {
  const stored = open(provider.apiKey);
  if (!stored) return { key: "", headers: {} };
  let credential: VertexCredential;
  try {
    credential = parseVertexCredential(stored);
  } catch (err) {
    logger.warn("provider.vertex_credential_unreadable", { providerId: provider.id, ...errorFields(err) });
    throw new GateError(503, "no_provider_key", "the stored Vertex AI credential cannot be read; save it again on the Providers page");
  }
  if (credential.type === "api_key") return { key: credential.key, headers: {}, keyHeader: GOOGLE_KEY_HEADER };
  return { key: await vertexAccessToken(provider.id, provider.apiKey, credential.account), headers: {} };
}
