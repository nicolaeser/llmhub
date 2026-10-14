import "server-only";
import { randomBytes } from "node:crypto";
import { open, pkceChallenge, seal } from "@/lib/crypto";
import { env } from "@/lib/env";
import { MCP_PROTOCOL_VERSION } from "@/lib/mcp/client";
import { McpError } from "@/lib/mcp/errors";
import { bearerChallenge } from "@/lib/mcp/headers";
import { readLimitedText } from "@/lib/mcp/sse";
import { checkServerUrl } from "@/lib/mcp/url-guard";
import { parseJsonOrNull } from "@/lib/utils/json";
import { cancelQuietly } from "@/lib/utils/streams";
import type { JsonMap } from "@/types/gateway";
import type {
  McpAuthServer,
  McpChallenge,
  McpFetch,
  McpOAuthClient,
  McpOAuthDiscovery,
  McpOAuthPending,
  McpResourceMetadata,
  McpTokenAuthMethod,
  McpTokenGrant,
} from "@/types/mcp";

export const MCP_OAUTH_CALLBACK_PATH = "/internal-api/mcp/oauth/callback";
export const MCP_OAUTH_CLIENT_PATH = "/internal-api/mcp/oauth/client";
export const MCP_OAUTH_PENDING_COOKIE =
  process.env.NODE_ENV === "production" ? "__Host-llmhub-mcp-oauth" : "llmhub_mcp_oauth";
export const MCP_OAUTH_FATAL_ERRORS = new Set(["invalid_grant", "invalid_client", "unauthorized_client"]);

const CLIENT_NAME = "LLM Hub";
const OAUTH_TIMEOUT_MS = 15_000;
const MAX_DOCUMENT_BYTES = 256 * 1024;
const PENDING_TTL_S = 600;
const OFFLINE_SCOPE = "offline_access";
const GRANT_TYPES = ["authorization_code", "refresh_token"];

function asMap(value: unknown): JsonMap | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonMap) : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
}

function authMethodOf(value: unknown): McpTokenAuthMethod | null {
  return value === "none" || value === "client_secret_basic" || value === "client_secret_post" ? value : null;
}

function registrationOf(value: unknown): McpOAuthClient["registration"] {
  return value === "manual" || value === "metadata" ? value : "dynamic";
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function appUrl(): string {
  return trimSlash(env.NEXT_PUBLIC_APP_URL);
}

export function mcpOAuthRedirectUri(base: string = env.NEXT_PUBLIC_APP_URL): string {
  return `${trimSlash(base)}${MCP_OAUTH_CALLBACK_PATH}`;
}

export function mcpOAuthClientId(base: string = env.NEXT_PUBLIC_APP_URL): string {
  return `${trimSlash(base)}${MCP_OAUTH_CLIENT_PATH}`;
}

function isLoopback(base: string): boolean {
  const host = new URL(base).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\./.test(host);
}

export function redirectAllowed(base: string = env.NEXT_PUBLIC_APP_URL): boolean {
  if (!URL.canParse(base)) return false;
  const url = new URL(base);
  return url.protocol === "https:" || (url.protocol === "http:" && isLoopback(base));
}

export function metadataDocumentUsable(base: string = env.NEXT_PUBLIC_APP_URL): boolean {
  return URL.canParse(base) && new URL(base).protocol === "https:" && checkServerUrl(base, false).ok;
}

export function mcpClientMetadata(base: string = env.NEXT_PUBLIC_APP_URL): JsonMap {
  return {
    client_id: mcpOAuthClientId(base),
    client_name: CLIENT_NAME,
    client_uri: trimSlash(base),
    redirect_uris: [mcpOAuthRedirectUri(base)],
    grant_types: GRANT_TYPES,
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

export function canonicalResource(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  const value = url.toString();
  return url.pathname === "/" && !url.search ? value.replace(/\/$/, "") : value;
}

export function resourceMatches(resource: string, serverUrl: string): boolean {
  if (!URL.canParse(resource)) return false;
  const claimed = new URL(canonicalResource(resource));
  const actual = new URL(canonicalResource(serverUrl));
  if (claimed.origin !== actual.origin) return false;
  const base = claimed.pathname.endsWith("/") ? claimed.pathname : `${claimed.pathname}/`;
  const path = actual.pathname.endsWith("/") ? actual.pathname : `${actual.pathname}/`;
  return path.startsWith(base);
}

export function resourceMetadataUrls(serverUrl: string, challenge: McpChallenge | null): string[] {
  const urls: string[] = [];
  if (challenge?.resourceMetadata && URL.canParse(challenge.resourceMetadata)) urls.push(challenge.resourceMetadata);
  const url = new URL(serverUrl);
  const path = trimSlash(url.pathname);
  if (path) urls.push(`${url.origin}/.well-known/oauth-protected-resource${path}`);
  urls.push(`${url.origin}/.well-known/oauth-protected-resource`);
  return [...new Set(urls)];
}

export function authServerMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = trimSlash(url.pathname);
  if (!path) {
    return [`${url.origin}/.well-known/oauth-authorization-server`, `${url.origin}/.well-known/openid-configuration`];
  }
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/openid-configuration${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`,
  ];
}

export function parseResourceMetadata(json: JsonMap | null): McpResourceMetadata | null {
  const resource = text(json?.resource);
  const authorizationServers = strings(json?.authorization_servers).filter((item) => URL.canParse(item));
  if (!resource || !authorizationServers.length) return null;
  return { resource, authorizationServers, scopesSupported: strings(json?.scopes_supported) };
}

export function parseAuthServer(json: JsonMap | null, issuer: string): McpAuthServer | null {
  const declared = text(json?.issuer);
  const tokenEndpoint = text(json?.token_endpoint);
  if (!declared || trimSlash(declared) !== trimSlash(issuer) || !tokenEndpoint || !URL.canParse(tokenEndpoint)) return null;
  const authorizationEndpoint = text(json?.authorization_endpoint);
  const registrationEndpoint = text(json?.registration_endpoint);
  return {
    issuer: declared,
    authorizationEndpoint: URL.canParse(authorizationEndpoint) ? authorizationEndpoint : "",
    tokenEndpoint,
    registrationEndpoint: URL.canParse(registrationEndpoint) ? registrationEndpoint : "",
    scopesSupported: strings(json?.scopes_supported),
    codeChallengeMethods: strings(json?.code_challenge_methods_supported),
    tokenAuthMethods: strings(json?.token_endpoint_auth_methods_supported),
    clientMetadataDocuments: json?.client_id_metadata_document_supported === true,
    issParameter: json?.authorization_response_iss_parameter_supported === true,
  };
}

function scopeSet(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}

export function selectScope(input: {
  configured: string;
  challenge: McpChallenge | null;
  metadata: McpResourceMetadata | null;
  previous: string;
  server: McpAuthServer;
  offline: boolean;
}): string {
  if (input.configured.trim()) return scopeSet(input.configured).join(" ");
  const base = input.challenge?.scope || (input.metadata?.scopesSupported ?? []).join(" ");
  const scopes = new Set([...scopeSet(input.previous), ...scopeSet(base)]);
  if (input.offline && scopes.size && input.server.scopesSupported.includes(OFFLINE_SCOPE)) scopes.add(OFFLINE_SCOPE);
  return [...scopes].join(" ");
}

export function tokenAuthMethod(supported: readonly string[]): McpTokenAuthMethod {
  if (!supported.length || supported.includes("client_secret_basic")) return "client_secret_basic";
  if (supported.includes("client_secret_post")) return "client_secret_post";
  return "client_secret_basic";
}

async function getJson(fetch: McpFetch, url: string): Promise<JsonMap | null> {
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
  });
  if (!res.ok) {
    await cancelQuietly(res.body);
    return null;
  }
  return asMap(parseJsonOrNull(await readLimitedText(res, MAX_DOCUMENT_BYTES)));
}

async function firstDocument<T>(fetch: McpFetch, urls: string[], parse: (json: JsonMap | null) => T | null): Promise<T | null> {
  for (const url of urls) {
    try {
      const found = parse(await getJson(fetch, url));
      if (found) return found;
    } catch (err) {
      if (!(err instanceof Error)) throw err;
    }
  }
  return null;
}

export async function probeChallenge(serverUrl: string, fetch: McpFetch): Promise<McpChallenge | null> {
  const meta = {
    "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientInfo": { name: "llmhub", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  try {
    const res = await fetch(serverUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        "Mcp-Method": "server/discover",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: meta } }),
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    });
    await cancelQuietly(res.body);
    return res.status === 401 || res.status === 403 ? bearerChallenge(res.headers.get("www-authenticate")) : null;
  } catch (err) {
    if (err instanceof McpError && err.code.startsWith("MCP_URL_")) throw err;
    return null;
  }
}

export async function discoverOAuth(
  input: { url: string; scopes: string; previousScope: string; offline: boolean },
  fetch: McpFetch,
): Promise<McpOAuthDiscovery> {
  const challenge = await probeChallenge(input.url, fetch);
  const metadata = await firstDocument(fetch, resourceMetadataUrls(input.url, challenge), parseResourceMetadata);
  if (metadata && !resourceMatches(metadata.resource, input.url)) {
    throw new McpError("MCP_OAUTH_DISCOVERY", "resource mismatch");
  }
  const issuers = metadata?.authorizationServers ?? [new URL(input.url).origin];
  let server: McpAuthServer | null = null;
  for (const issuer of issuers) {
    server = await firstDocument(fetch, authServerMetadataUrls(issuer), (json) => parseAuthServer(json, issuer));
    if (server) break;
  }
  if (!server) throw new McpError("MCP_OAUTH_DISCOVERY", "no authorization server metadata");
  return {
    resource: metadata ? canonicalResource(metadata.resource) : canonicalResource(input.url),
    scope: selectScope({
      configured: input.scopes,
      challenge,
      metadata,
      previous: input.previousScope,
      server,
      offline: input.offline,
    }),
    server,
  };
}

export function assertEndpoint(url: string, internal: boolean): void {
  const verdict = checkServerUrl(url, internal);
  if (!verdict.ok) throw new McpError("MCP_OAUTH_DISCOVERY", verdict.code);
}

export async function registerClient(
  input: { server: McpAuthServer; scope: string; redirectUri: string },
  fetch: McpFetch,
): Promise<McpOAuthClient> {
  if (input.server.clientMetadataDocuments && metadataDocumentUsable()) {
    return { clientId: mcpOAuthClientId(), clientSecret: "", authMethod: "none", registration: "metadata", redirectUri: input.redirectUri };
  }
  if (!input.server.registrationEndpoint) throw new McpError("MCP_OAUTH_CLIENT_REQUIRED");
  const supported = input.server.tokenAuthMethods;
  const requested: McpTokenAuthMethod = supported.includes("client_secret_basic")
    ? "client_secret_basic"
    : supported.includes("client_secret_post")
      ? "client_secret_post"
      : "none";
  const res = await fetch(input.server.registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      client_uri: appUrl(),
      redirect_uris: [input.redirectUri],
      grant_types: GRANT_TYPES,
      response_types: ["code"],
      token_endpoint_auth_method: requested,
      application_type: isLoopback(appUrl()) ? "native" : "web",
      ...(input.scope ? { scope: input.scope } : {}),
    }),
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
  });
  const json = res.ok ? asMap(parseJsonOrNull(await readLimitedText(res, MAX_DOCUMENT_BYTES))) : null;
  if (!res.ok) await cancelQuietly(res.body);
  const clientId = text(json?.client_id);
  if (!clientId) throw new McpError("MCP_OAUTH_REGISTRATION", `HTTP ${res.status}`);
  const clientSecret = text(json?.client_secret);
  const fallback: McpTokenAuthMethod = !clientSecret ? "none" : requested === "none" ? "client_secret_basic" : requested;
  const authMethod = authMethodOf(text(json?.token_endpoint_auth_method)) ?? fallback;
  return { clientId, clientSecret, authMethod, registration: "dynamic", redirectUri: input.redirectUri };
}

export function manualClient(
  input: { clientId: string; sealedSecret: string; redirectUri: string },
  server: Pick<McpAuthServer, "tokenAuthMethods">,
): McpOAuthClient {
  const clientSecret = input.sealedSecret ? open(input.sealedSecret) : "";
  return {
    clientId: input.clientId,
    clientSecret,
    authMethod: clientSecret ? tokenAuthMethod(server.tokenAuthMethods) : "none",
    registration: "manual",
    redirectUri: input.redirectUri,
  };
}

export function authorizationUrl(server: McpAuthServer, client: McpOAuthClient, pending: McpOAuthPending): string {
  const url = new URL(server.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", client.redirectUri);
  url.searchParams.set("state", pending.state);
  url.searchParams.set("code_challenge", pkceChallenge(pending.verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", pending.resource);
  if (pending.scope) url.searchParams.set("scope", pending.scope);
  return url.toString();
}

export function issuerAccepted(pending: Pick<McpOAuthPending, "issuer" | "issParameter">, iss: string | null): boolean {
  if (iss !== null) return iss === pending.issuer;
  return !pending.issParameter;
}

function formEncode(value: string): string {
  return new URLSearchParams({ v: value }).toString().slice(2);
}

export async function tokenRequest(
  fetch: McpFetch,
  endpoint: string,
  client: Pick<McpOAuthClient, "clientId" | "clientSecret" | "authMethod">,
  params: Record<string, string>,
  now = Date.now(),
): Promise<McpTokenGrant> {
  const body = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== ""));
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (client.authMethod === "client_secret_basic" && client.clientSecret) {
    const credentials = `${formEncode(client.clientId)}:${formEncode(client.clientSecret)}`;
    headers.Authorization = `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;
  } else {
    body.set("client_id", client.clientId);
    if (client.authMethod === "client_secret_post" && client.clientSecret) body.set("client_secret", client.clientSecret);
  }
  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: body.toString(),
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
  });
  const json = asMap(parseJsonOrNull(await readLimitedText(res, MAX_DOCUMENT_BYTES).catch(() => "")));
  const access = text(json?.access_token);
  if (!res.ok || !access) {
    throw new McpError("MCP_OAUTH_TOKEN", text(json?.error).slice(0, 64) || `HTTP ${res.status}`);
  }
  const type = text(json?.token_type).toLowerCase();
  if (type && type !== "bearer") throw new McpError("MCP_OAUTH_TOKEN", "unsupported token type");
  const rawExpiry = json?.expires_in;
  const expiresIn = typeof rawExpiry === "number" ? rawExpiry : Number(text(rawExpiry));
  return {
    access,
    refresh: text(json?.refresh_token),
    scope: text(json?.scope),
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(now + expiresIn * 1000) : null,
  };
}

export function newPending(
  input: Omit<McpOAuthPending, "state" | "verifier" | "issuedAt">,
  now = Date.now(),
): McpOAuthPending {
  return {
    ...input,
    state: randomBytes(32).toString("base64url"),
    verifier: randomBytes(48).toString("base64url"),
    issuedAt: now,
  };
}

export function sealPending(pending: McpOAuthPending): string {
  return seal(JSON.stringify(pending));
}

export function openPending(value: string, now = Date.now()): McpOAuthPending | null {
  const rec = asMap(parseJsonOrNull(open(value)));
  const client = asMap(rec?.client);
  if (!rec || !client) return null;
  const issuedAt = typeof rec.issuedAt === "number" ? rec.issuedAt : 0;
  if (now - issuedAt > PENDING_TTL_S * 1000 || issuedAt > now + 60_000) return null;
  const pending: McpOAuthPending = {
    serverId: text(rec.serverId),
    userId: text(rec.userId),
    url: text(rec.url),
    state: text(rec.state),
    verifier: text(rec.verifier),
    issuer: typeof rec.issuer === "string" ? rec.issuer : "",
    issParameter: rec.issParameter === true,
    tokenEndpoint: text(rec.tokenEndpoint),
    resource: text(rec.resource),
    scope: text(rec.scope),
    client: {
      clientId: text(client.clientId),
      clientSecret: typeof client.clientSecret === "string" ? client.clientSecret : "",
      authMethod: authMethodOf(client.authMethod) ?? "none",
      registration: registrationOf(client.registration),
      redirectUri: text(client.redirectUri),
    },
    issuedAt,
  };
  const complete = [pending.serverId, pending.userId, pending.state, pending.verifier, pending.issuer, pending.tokenEndpoint, pending.client.clientId];
  return complete.every(Boolean) ? pending : null;
}

export function pendingCookieOptions(maxAge = PENDING_TTL_S) {
  return {
    name: MCP_OAUTH_PENDING_COOKIE,
    maxAge,
    path: "/",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
  };
}

export function sealClient(client: McpOAuthClient): string {
  return seal(JSON.stringify(client));
}

export function openClient(value: string): McpOAuthClient | null {
  const rec = asMap(parseJsonOrNull(open(value)));
  const clientId = text(rec?.clientId);
  if (!rec || !clientId) return null;
  return {
    clientId,
    clientSecret: typeof rec.clientSecret === "string" ? rec.clientSecret : "",
    authMethod: authMethodOf(rec.authMethod) ?? "none",
    registration: registrationOf(rec.registration),
    redirectUri: text(rec.redirectUri),
  };
}
