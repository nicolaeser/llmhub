import "server-only";
import { open, seal } from "@/lib/crypto";
import type { AuthMethod, CredentialMetadata, SecretEnvelope } from "@/types/integrations";

export function sealEnvelope(envelope: SecretEnvelope): string {
  return seal(JSON.stringify(envelope));
}

export function openEnvelope(sealed: string): SecretEnvelope {
  if (!sealed) return {};
  try {
    const parsed = JSON.parse(open(sealed)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const rec = parsed as Record<string, unknown>;
    const pick = (key: keyof SecretEnvelope) => (typeof rec[key] === "string" ? (rec[key] as string) : undefined);
    return {
      accessToken: pick("accessToken"),
      refreshToken: pick("refreshToken"),
      clientSecret: pick("clientSecret"),
      verifier: pick("verifier"),
      password: pick("password"),
      apiKey: pick("apiKey"),
    };
  } catch {
    return {};
  }
}

export function metadataOf(value: unknown): CredentialMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const rec = value as Record<string, unknown>;
  return {
    headerName: typeof rec.headerName === "string" ? rec.headerName : undefined,
    tokenUrl: typeof rec.tokenUrl === "string" ? rec.tokenUrl : undefined,
    authorizeUrl: typeof rec.authorizeUrl === "string" ? rec.authorizeUrl : undefined,
    clientId: typeof rec.clientId === "string" ? rec.clientId : undefined,
    scopes: Array.isArray(rec.scopes) ? rec.scopes.filter((item) => typeof item === "string") : undefined,
    state: typeof rec.state === "string" ? rec.state : undefined,
  };
}

export function authHeadersFor(
  method: AuthMethod,
  envelope: SecretEnvelope,
  metadata: CredentialMetadata,
): Record<string, string> {
  if (method === "api_key" && envelope.apiKey) {
    return { [metadata.headerName || "x-api-key"]: envelope.apiKey };
  }
  if ((method === "bearer" || method === "oauth2" || method === "service_account") && envelope.accessToken) {
    return { authorization: `Bearer ${envelope.accessToken}` };
  }
  if (method === "basic" && envelope.apiKey) {
    const raw = envelope.password ? `${envelope.apiKey}:${envelope.password}` : envelope.apiKey;
    return { authorization: `Basic ${Buffer.from(raw).toString("base64")}` };
  }
  if (method === "header" && envelope.apiKey) {
    return { [metadata.headerName || "x-api-key"]: envelope.apiKey };
  }
  if (method === "custom" && envelope.apiKey) {
    return { [metadata.headerName || "authorization"]: envelope.apiKey };
  }
  return {};
}
