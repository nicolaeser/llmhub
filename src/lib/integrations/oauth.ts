import { createHash, randomBytes } from "node:crypto";
import type { SecretEnvelope } from "@/types/integrations";

const REDIRECT = "urn:ietf:wg:oauth:2.0:oob";

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function oauthState(): string {
  return randomBytes(16).toString("base64url");
}

export function authorizeUrl(input: {
  authorizeUrl: string;
  clientId: string;
  scopes: readonly string[];
  state: string;
  challenge: string;
}): string {
  const url = new URL(input.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", REDIRECT);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (input.scopes.length) url.searchParams.set("scope", input.scopes.join(" "));
  return url.toString();
}

type TokenFetch = (input: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}) => Promise<{ status: number; body: string }>;

function tokenBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

export async function exchangeCode(
  input: {
    tokenUrl: string;
    clientId: string;
    clientSecret?: string;
    code: string;
    verifier: string;
  },
  fetch: TokenFetch,
): Promise<{ envelope: SecretEnvelope; expiresAt: string; scopes: string[] }> {
  return readToken(
    input.tokenUrl,
    tokenBody({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: REDIRECT,
      client_id: input.clientId,
      code_verifier: input.verifier,
      ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
    }),
    fetch,
  );
}

export async function exchangeClient(
  input: { tokenUrl: string; clientId: string; clientSecret: string; scopes: readonly string[] },
  fetch: TokenFetch,
): Promise<{ envelope: SecretEnvelope; expiresAt: string; scopes: string[] }> {
  return readToken(
    input.tokenUrl,
    tokenBody({
      grant_type: "client_credentials",
      client_id: input.clientId,
      client_secret: input.clientSecret,
      ...(input.scopes.length ? { scope: input.scopes.join(" ") } : {}),
    }),
    fetch,
  );
}

export async function refreshAccess(
  input: { tokenUrl: string; clientId: string; clientSecret?: string; refreshToken: string },
  fetch: TokenFetch,
): Promise<{ envelope: SecretEnvelope; expiresAt: string; scopes: string[] }> {
  return readToken(
    input.tokenUrl,
    tokenBody({
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
    }),
    fetch,
  );
}

async function readToken(
  tokenUrl: string,
  body: string,
  fetch: TokenFetch,
): Promise<{ envelope: SecretEnvelope; expiresAt: string; scopes: string[] }> {
  const response = await fetch({
    url: tokenUrl,
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error("CREDENTIAL_REQUIRED");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new Error("CREDENTIAL_REQUIRED");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("CREDENTIAL_REQUIRED");
  const rec = parsed as Record<string, unknown>;
  const access = typeof rec.access_token === "string" ? rec.access_token : "";
  if (!access) throw new Error("CREDENTIAL_REQUIRED");
  const refresh = typeof rec.refresh_token === "string" ? rec.refresh_token : undefined;
  const expiresIn = typeof rec.expires_in === "number" ? rec.expires_in : 0;
  const scope = typeof rec.scope === "string" ? rec.scope.split(/\s+/).filter(Boolean) : [];
  return {
    envelope: { accessToken: access, ...(refresh ? { refreshToken: refresh } : {}) },
    expiresAt: expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : "",
    scopes: scope,
  };
}
