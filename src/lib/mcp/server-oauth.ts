import "server-only";
import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import prisma from "@/lib/db/prisma";
import { requirePermission } from "@/lib/auth/guards";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { writeAudit } from "@/lib/audit";
import { loginData } from "@/lib/mcp/auth";
import { McpError, mcpErrorCode } from "@/lib/mcp/errors";
import {
  MCP_OAUTH_PENDING_COOKIE,
  assertEndpoint,
  authorizationUrl,
  discoverOAuth,
  issuerAccepted,
  manualClient,
  mcpOAuthRedirectUri,
  newPending,
  openClient,
  openPending,
  pendingCookieOptions,
  redirectAllowed,
  registerClient,
  sealPending,
  tokenRequest,
} from "@/lib/mcp/oauth";
import { assertUrl, parse } from "@/lib/mcp/server-input";
import { probe, storeProbe } from "@/lib/mcp/server-probe";
import { loadRow, scopedView } from "@/lib/mcp/server-view";
import { serverRecord } from "@/lib/mcp/toolset";
import { guardedFetch } from "@/lib/mcp/transport";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { mcpOAuthCallbackSchema, mcpServerIdSchema } from "@/schemas/mcp";

async function mcpStep<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof McpError) throw err;
    const code = mcpErrorCode(err);
    logger.warn("mcp.oauth_failed", { code, ...errorFields(err) });
    throw new McpError(code);
  }
}

export async function startMcpOAuth(rawId: unknown) {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  const row = await loadRow(parse(mcpServerIdSchema, rawId));
  const record = serverRecord(row);
  if (record.authType !== "oauth" || record.oauthGrant !== "authorization_code") throw new Error("VALIDATION");
  if (!redirectAllowed()) throw new McpError("MCP_OAUTH_APP_URL");
  assertUrl(record.url, record.internal);
  const fetch = guardedFetch(record.internal);
  const discovery = await mcpStep(() =>
    discoverOAuth(
      { url: record.url, scopes: record.oauthScopes, previousScope: row.oauthLogin?.scope ?? "", offline: true },
      fetch,
    ),
  );
  const { server } = discovery;
  if (!server.authorizationEndpoint) throw new McpError("MCP_OAUTH_UNSUPPORTED", "authorization endpoint");
  if (!server.codeChallengeMethods.includes("S256")) throw new McpError("MCP_OAUTH_UNSUPPORTED", "PKCE S256");
  assertEndpoint(server.authorizationEndpoint, record.internal);
  const redirectUri = mcpOAuthRedirectUri();
  const stored = row.oauthLogin && row.oauthLogin.issuer === server.issuer ? openClient(row.oauthLogin.client) : null;
  const reusable = stored && stored.registration !== "manual" && stored.redirectUri === redirectUri ? stored : null;
  const client = record.oauthClientId
    ? manualClient({ clientId: record.oauthClientId, sealedSecret: record.authSecret, redirectUri }, server)
    : (reusable ?? (await mcpStep(() => registerClient({ server, scope: discovery.scope, redirectUri }, fetch))));
  const pending = newPending({
    serverId: row.id,
    userId: session.user.id,
    url: record.url,
    issuer: server.issuer,
    issParameter: server.issParameter,
    tokenEndpoint: server.tokenEndpoint,
    resource: discovery.resource,
    scope: discovery.scope,
    client,
  });
  (await cookies()).set({ ...pendingCookieOptions(), value: sealPending(pending) });
  return { url: authorizationUrl(server, client, pending) };
}

function sameState(expected: string, given: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function completeMcpOAuth(raw: unknown) {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  const input = parse(mcpOAuthCallbackSchema, raw);
  const store = await cookies();
  const sealed = store.get(MCP_OAUTH_PENDING_COOKIE)?.value ?? "";
  store.delete(MCP_OAUTH_PENDING_COOKIE);
  const pending = sealed ? openPending(sealed) : null;
  if (!pending || pending.userId !== session.user.id || !sameState(pending.state, input.state)) {
    throw new McpError("MCP_OAUTH_STATE");
  }
  if (!issuerAccepted(pending, input.iss)) throw new McpError("MCP_OAUTH_STATE", "issuer mismatch");
  if (input.error) throw new McpError(input.error === "access_denied" ? "MCP_OAUTH_DENIED" : "MCP_OAUTH_TOKEN", input.error);
  if (!input.code) throw new McpError("MCP_OAUTH_STATE");
  const row = await loadRow(pending.serverId);
  const record = serverRecord(row);
  if (record.url !== pending.url || record.authType !== "oauth" || record.oauthGrant !== "authorization_code") {
    throw new McpError("MCP_OAUTH_STATE", "server changed");
  }
  const grant = await mcpStep(() =>
    tokenRequest(guardedFetch(record.internal), pending.tokenEndpoint, pending.client, {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: pending.client.redirectUri,
      code_verifier: pending.verifier,
      resource: pending.resource,
    }),
  );
  const data = loginData({ ...pending, grant });
  const connectedAt = new Date();
  await prisma.mcpOAuthLogin.upsert({
    where: { serverId: row.id },
    create: { serverId: row.id, ...data, connectedAt },
    update: { ...data, connectedAt, version: { increment: 1 } },
  });
  await writeAudit({
    actor: session.user.id,
    action: "mcp_server.oauth_connect",
    objectType: "mcp_server",
    objectId: row.id,
    after: { issuer: pending.issuer, scope: data.scope, registration: pending.client.registration },
  });
  const refreshed = await storeProbe(row.id, await probe(record));
  return { server: scopedView(refreshed, session) };
}

export async function disconnectMcpOAuth(rawId: unknown) {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  const id = parse(mcpServerIdSchema, rawId);
  const before = await loadRow(id);
  await prisma.mcpOAuthLogin.deleteMany({ where: { serverId: id } });
  await writeAudit({
    actor: session.user.id,
    action: "mcp_server.oauth_disconnect",
    objectType: "mcp_server",
    objectId: id,
    before: { connected: Boolean(before.oauthLogin), issuer: before.oauthLogin?.issuer ?? "" },
  });
  return { server: scopedView(await loadRow(id), session) };
}
