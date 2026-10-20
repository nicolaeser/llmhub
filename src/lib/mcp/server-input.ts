import "server-only";
import { seal } from "@/lib/crypto";
import { isOAuthGrant } from "@/lib/mcp/toolset";
import { checkServerUrl } from "@/lib/mcp/url-guard";
import { authUsesName } from "@/schemas/mcp";

export function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("VALIDATION");
  return parsed.data;
}

export function assertUrl(url: string, internal: boolean): void {
  const verdict = checkServerUrl(url, internal);
  if (!verdict.ok) throw new Error(verdict.code);
}

export function assertRemoteAuth(authType: string): void {
  if (authType === "query") throw new Error("VALIDATION");
}

export function secretRequired(input: { authType: string; oauthGrant: string }): boolean {
  if (input.authType === "oauth") return input.oauthGrant === "client_credentials";
  return input.authType !== "none";
}

export function secretFor(authType: string, input: { secret: string; clearSecret?: boolean }, current: string): string {
  if (authType === "none") return "";
  if (input.secret.trim()) return seal(input.secret.trim());
  if (input.clearSecret) return "";
  return current;
}

export function connectionFields(input: {
  authType: string;
  authHeader: string;
  oauthGrant: string;
  oauthClientId: string;
  oauthScopes: string;
}) {
  const oauth = input.authType === "oauth";
  return {
    authHeader: authUsesName(input.authType) ? input.authHeader : "",
    oauthGrant: oauth && isOAuthGrant(input.oauthGrant) ? input.oauthGrant : "authorization_code",
    oauthClientId: oauth ? input.oauthClientId : "",
    oauthScopes: oauth ? input.oauthScopes : "",
  };
}
