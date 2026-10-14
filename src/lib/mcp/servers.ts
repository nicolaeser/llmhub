import "server-only";
import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import prisma from "@/lib/db/prisma";
import { requirePermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { isPrismaCode } from "@/lib/auth/errors";
import { writeAudit } from "@/lib/audit";
import { seal } from "@/lib/crypto";
import { assignmentViews, mcpAssignmentSelect, replaceMcpAssignments, targetOptions } from "@/lib/mcp/assignments";
import { loginData, trialClientCredentials } from "@/lib/mcp/auth";
import { eraOf, toolSpecs } from "@/lib/mcp/client";
import { McpError, mcpErrorCode, type McpErrorCode } from "@/lib/mcp/errors";
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
import { toolSpecOf } from "@/lib/mcp/hosted";
import { isOAuthGrant, mcpClientFor, serverRecord } from "@/lib/mcp/toolset";
import { guardedFetch } from "@/lib/mcp/transport";
import { checkServerUrl } from "@/lib/mcp/url-guard";
import { errorFields } from "@/lib/logging/format";
import { enabledModelChoices } from "@/lib/models/aliases";
import { chatChoices } from "@/lib/models/model-role";
import { logger } from "@/lib/logging/logger";
import {
  BUILDER_MODEL_KEY,
  hostedServerSchema,
  mcpAssignmentsSchema,
  mcpOAuthCallbackSchema,
  mcpProbeSchema,
  mcpServerIdSchema,
  mcpServerInputSchema,
} from "@/schemas/mcp";
import type { Prisma } from "@/generated/prisma/client";
import type { McpAuth, McpOAuthView, McpProbeResult, McpServerRecord, McpServerStatus, McpServerView } from "@/types/mcp";

const PROBE_TIMEOUT_MS = 20_000;

const serverSelect = {
  id: true,
  name: true,
  description: true,
  url: true,
  transport: true,
  protocolVersion: true,
  kind: true,
  spec: true,
  authType: true,
  authHeader: true,
  authSecret: true,
  oauthGrant: true,
  oauthClientId: true,
  oauthScopes: true,
  internal: true,
  enabled: true,
  global: true,
  toolsRestricted: true,
  allowedTools: true,
  tools: true,
  refreshedAt: true,
  lastError: true,
  updatedAt: true,
  assignments: mcpAssignmentSelect,
  oauthLogin: { select: { status: true, scope: true, expiresAt: true, connectedAt: true, issuer: true, client: true } },
} as const satisfies Prisma.McpServerSelect;

type ServerRow = Prisma.McpServerGetPayload<{ select: typeof serverSelect }>;

function needsSignIn(row: Pick<ServerRow, "authType" | "oauthGrant" | "lastError" | "oauthLogin">): boolean {
  if (row.authType !== "oauth") return false;
  if (row.lastError === "MCP_AUTH_REQUIRED") return true;
  return row.oauthGrant !== "client_credentials" && row.oauthLogin?.status !== "active";
}

function statusOf(row: Pick<ServerRow, "enabled" | "lastError" | "refreshedAt" | "authType" | "oauthGrant" | "oauthLogin">): McpServerStatus {
  if (!row.enabled) return "disabled";
  if (needsSignIn(row)) return "signin";
  if (row.lastError) return "error";
  return row.refreshedAt ? "connected" : "unchecked";
}

function shownUrl(url: string): string {
  return URL.canParse(url) ? new URL(url).origin : "";
}

function oauthView(row: ServerRow): McpOAuthView | null {
  if (row.authType !== "oauth" || !row.oauthLogin) return null;
  return {
    status: row.oauthLogin.status === "active" ? "active" : "expired",
    scope: row.oauthLogin.scope,
    expiresAt: row.oauthLogin.expiresAt?.toISOString() ?? null,
    connectedAt: row.oauthLogin.connectedAt.toISOString(),
  };
}

function viewOf(row: ServerRow, canManage = true): McpServerView {
  const record = serverRecord(row);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    url: canManage ? row.url : shownUrl(row.url),
    authType: record.authType,
    authHeader: row.authHeader,
    hasSecret: Boolean(row.authSecret),
    oauthGrant: record.oauthGrant,
    oauthClientId: canManage ? row.oauthClientId : "",
    oauthScopes: row.oauthScopes,
    oauth: oauthView(row),
    internal: row.internal,
    kind: row.kind === "hosted" ? "hosted" : "remote",
    enabled: row.enabled,
    global: row.global,
    toolsRestricted: row.toolsRestricted,
    allowedTools: row.allowedTools,
    tools: toolSpecs(row.tools),
    transport: record.transport,
    protocolVersion: row.protocolVersion,
    era: eraOf(record),
    refreshedAt: row.refreshedAt?.toISOString() ?? null,
    lastError: row.lastError,
    status: statusOf(row),
    assignments: assignmentViews(row.assignments),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("VALIDATION");
  return parsed.data;
}

function assertUrl(url: string, internal: boolean): void {
  const verdict = checkServerUrl(url, internal);
  if (!verdict.ok) throw new Error(verdict.code);
}

function failedProbe(error: McpErrorCode): McpProbeResult {
  return { connected: false, tools: [], serverName: "", error, transport: null, protocolVersion: "", era: null };
}

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

function probeCode(err: unknown, record: Pick<McpServerRecord, "authType">): McpErrorCode {
  const code = mcpErrorCode(err);
  if (code !== "MCP_AUTH_FAILED" || record.authType === "oauth" || !(err instanceof McpError)) return code;
  if (err.challenge) return "MCP_OAUTH_SUGGESTED";
  return record.authType === "none" ? "MCP_AUTH_REQUIRED" : code;
}

async function probe(record: McpServerRecord, auth?: McpAuth): Promise<McpProbeResult> {
  const client = mcpClientFor(record, guardedFetch(record.internal), { timeoutMs: PROBE_TIMEOUT_MS, auth });
  try {
    const serverName = await client.discover();
    const tools = await client.listTools(undefined, (tool, reason) => {
      logger.warn("mcp.tool_rejected", { serverId: record.id, tool, reason });
    });
    const connection = client.connection;
    return {
      connected: true,
      tools,
      serverName,
      error: "",
      transport: connection?.transport ?? null,
      protocolVersion: connection?.protocolVersion ?? "",
      era: eraOf(connection),
    };
  } catch (err) {
    const code = probeCode(err, record);
    logger.warn("mcp.probe_failed", { code, ...(err instanceof McpError ? {} : errorFields(err)) });
    return failedProbe(code);
  } finally {
    await client.close();
  }
}

async function loadRow(id: string): Promise<ServerRow> {
  const row = await prisma.mcpServer.findUnique({ where: { id }, select: serverSelect });
  if (!row) throw new Error("NOT_FOUND");
  return row;
}

async function storeProbe(id: string, result: McpProbeResult): Promise<ServerRow> {
  return prisma.mcpServer.update({
    where: { id },
    data: result.connected
      ? {
          tools: result.tools as unknown as Prisma.InputJsonValue,
          refreshedAt: new Date(),
          lastError: "",
          ...(result.transport ? { transport: result.transport, protocolVersion: result.protocolVersion } : {}),
        }
      : { lastError: result.error },
    select: serverSelect,
  });
}

function secretRequired(input: { authType: string; oauthGrant: string }): boolean {
  if (input.authType === "oauth") return input.oauthGrant === "client_credentials";
  return input.authType !== "none";
}

function secretFor(authType: string, input: { secret: string; clearSecret?: boolean }, current: string): string {
  if (authType === "none") return "";
  if (input.secret.trim()) return seal(input.secret.trim());
  if (input.clearSecret) return "";
  return current;
}

function auditShape(
  row: Pick<
    ServerRow,
    | "name"
    | "url"
    | "authType"
    | "authHeader"
    | "authSecret"
    | "oauthGrant"
    | "oauthClientId"
    | "oauthScopes"
    | "internal"
    | "enabled"
    | "global"
    | "toolsRestricted"
    | "allowedTools"
  >,
) {
  return {
    name: row.name,
    url: row.url,
    authType: row.authType,
    authHeader: row.authHeader,
    hasSecret: Boolean(row.authSecret),
    oauthGrant: row.oauthGrant,
    oauthClientId: row.oauthClientId,
    oauthScopes: row.oauthScopes,
    internal: row.internal,
    enabled: row.enabled,
    global: row.global,
    toolsRestricted: row.toolsRestricted,
    allowedTools: row.allowedTools,
  };
}

function connectionFields(input: {
  authType: string;
  authHeader: string;
  oauthGrant: string;
  oauthClientId: string;
  oauthScopes: string;
}) {
  const oauth = input.authType === "oauth";
  return {
    authHeader: input.authType === "header" ? input.authHeader : "",
    oauthGrant: oauth && isOAuthGrant(input.oauthGrant) ? input.oauthGrant : "authorization_code",
    oauthClientId: oauth ? input.oauthClientId : "",
    oauthScopes: oauth ? input.oauthScopes : "",
  };
}

export async function loadMcpServerList() {
  const session = await requirePermission(PERMISSIONS.SETTINGS_READ);
  const [rows, setting, choices] = await Promise.all([
    prisma.mcpServer.findMany({ select: serverSelect, orderBy: { name: "asc" } }),
    prisma.setting.findUnique({ where: { key: BUILDER_MODEL_KEY } }),
    enabledModelChoices(),
  ]);
  const canManage = hasPerm(session.permissions, PERMISSIONS.SETTINGS_MANAGE);
  return {
    servers: rows.map((row) => viewOf(row, canManage)),
    canManage,
    redirectUri: canManage ? mcpOAuthRedirectUri() : "",
    builderModel: setting?.value ?? "",
    models: chatChoices(choices).map((choice) => ({ alias: choice.alias, label: choice.label })),
  };
}

export async function createMcpServer(raw: unknown) {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  const input = parse(mcpServerInputSchema, raw);
  assertUrl(input.url, input.internal);
  const authSecret = secretFor(input.authType, input, "");
  if (secretRequired(input) && !authSecret) throw new Error("MCP_SECRET_REQUIRED");
  let created: ServerRow;
  try {
    created = await prisma.mcpServer.create({
      data: {
        name: input.name,
        description: input.description,
        url: input.url,
        authType: input.authType,
        ...connectionFields(input),
        authSecret,
        internal: input.internal,
        enabled: input.enabled,
        global: input.global,
        toolsRestricted: input.toolsRestricted,
        allowedTools: [...new Set(input.allowedTools)],
      },
      select: serverSelect,
    });
  } catch (err) {
    if (isPrismaCode(err, "P2002")) throw new Error("NAME_EXISTS", { cause: err });
    throw err;
  }
  await writeAudit({
    actor: session.user.id,
    action: "mcp_server.create",
    objectType: "mcp_server",
    objectId: created.id,
    after: auditShape(created),
  });
  const refreshed = await storeProbe(created.id, await probe(serverRecord(created)));
  return { server: viewOf(refreshed) };
}

export async function createHostedMcpServer(raw: unknown) {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  const input = parse(hostedServerSchema, raw);
  assertUrl(input.baseUrl, input.internal);
  const tools = input.tools.map(toolSpecOf);
  let created: ServerRow;
  try {
    created = await prisma.mcpServer.create({
      data: {
        name: input.name,
        description: input.description,
        url: input.baseUrl,
        kind: "hosted",
        spec: { tools: input.tools } as Prisma.InputJsonValue,
        authType: input.authType,
        authHeader: input.authType === "header" ? input.authHeader : "",
        authSecret: input.secret.trim() ? seal(input.secret.trim()) : "",
        internal: input.internal,
        enabled: true,
        tools: tools as unknown as Prisma.InputJsonValue,
        refreshedAt: new Date(),
      },
      select: serverSelect,
    });
  } catch (err) {
    if (isPrismaCode(err, "P2002")) throw new Error("NAME_EXISTS", { cause: err });
    throw err;
  }
  await writeAudit({
    actor: session.user.id,
    action: "mcp_server.create",
    objectType: "mcp_server",
    objectId: created.id,
    after: { ...auditShape(created), kind: "hosted", tools: tools.map((tool) => tool.name) },
  });
  return { server: viewOf(created) };
}

export async function updateMcpServer(raw: { id: string } & Record<string, unknown>) {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  if (!raw?.id || typeof raw.id !== "string") throw new Error("MISSING_ID");
  const input = parse(mcpServerInputSchema, raw);
  assertUrl(input.url, input.internal);
  const before = await loadRow(raw.id);
  if (before.kind === "hosted") {
    if (input.authType === "oauth") throw new Error("VALIDATION");
    const authSecret = secretFor(input.authType, input, before.authSecret);
    if (secretRequired(input) && !authSecret) throw new Error("MCP_SECRET_REQUIRED");
    const fields = connectionFields(input);
    let updated: ServerRow;
    try {
      updated = await prisma.mcpServer.update({
        where: { id: raw.id },
        data: {
          name: input.name,
          description: input.description,
          url: input.url,
          authType: input.authType,
          ...fields,
          authSecret,
          internal: input.internal,
          enabled: input.enabled,
          global: input.global,
          toolsRestricted: input.toolsRestricted,
          allowedTools: [...new Set(input.allowedTools)],
        },
        select: serverSelect,
      });
    } catch (err) {
      if (isPrismaCode(err, "P2002")) throw new Error("NAME_EXISTS", { cause: err });
      if (isPrismaCode(err, "P2025")) throw new Error("NOT_FOUND", { cause: err });
      throw err;
    }
    await writeAudit({
      actor: session.user.id,
      action: "mcp_server.update",
      objectType: "mcp_server",
      objectId: updated.id,
      before: auditShape(before),
      after: auditShape(updated),
    });
    return { server: viewOf(updated) };
  }
  const authSecret = secretFor(input.authType, input, before.authSecret);
  if (secretRequired(input) && !authSecret) throw new Error("MCP_SECRET_REQUIRED");
  const fields = connectionFields(input);
  const identityChanged =
    before.url !== input.url ||
    before.authType !== input.authType ||
    before.oauthGrant !== fields.oauthGrant ||
    before.oauthClientId !== fields.oauthClientId ||
    before.authSecret !== authSecret;
  const connectionChanged =
    identityChanged ||
    before.authHeader !== fields.authHeader ||
    before.oauthScopes !== fields.oauthScopes ||
    before.internal !== input.internal;
  let updated: ServerRow;
  try {
    updated = await prisma.$transaction(async (tx) => {
      if (identityChanged) await tx.mcpOAuthLogin.deleteMany({ where: { serverId: raw.id } });
      return tx.mcpServer.update({
        where: { id: raw.id },
        data: {
          name: input.name,
          description: input.description,
          url: input.url,
          authType: input.authType,
          ...fields,
          authSecret,
          internal: input.internal,
          enabled: input.enabled,
          global: input.global,
          toolsRestricted: input.toolsRestricted,
          allowedTools: [...new Set(input.allowedTools)],
          ...(connectionChanged ? { lastError: "", refreshedAt: null } : {}),
          ...(before.url !== input.url ? { tools: [], transport: "streamable_http", protocolVersion: "" } : {}),
        },
        select: serverSelect,
      });
    });
  } catch (err) {
    if (isPrismaCode(err, "P2002")) throw new Error("NAME_EXISTS", { cause: err });
    if (isPrismaCode(err, "P2025")) throw new Error("NOT_FOUND", { cause: err });
    throw err;
  }
  await writeAudit({
    actor: session.user.id,
    action: "mcp_server.update",
    objectType: "mcp_server",
    objectId: updated.id,
    before: auditShape(before),
    after: { ...auditShape(updated), ...(identityChanged && before.oauthLogin ? { oauthDisconnected: true } : {}) },
  });
  if (!updated.enabled) return { server: viewOf(updated) };
  const refreshed = await storeProbe(updated.id, await probe(serverRecord(updated)));
  return { server: viewOf(refreshed) };
}

export async function setMcpServerEnabled(input: { id: string; enabled: boolean }) {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  if (!input?.id) throw new Error("MISSING_ID");
  const before = await loadRow(input.id);
  const updated = await prisma.mcpServer.update({
    where: { id: input.id },
    data: { enabled: Boolean(input.enabled) },
    select: serverSelect,
  });
  await writeAudit({
    actor: session.user.id,
    action: "mcp_server.update",
    objectType: "mcp_server",
    objectId: updated.id,
    before: { enabled: before.enabled },
    after: { enabled: updated.enabled },
  });
  return { server: viewOf(updated) };
}

export async function deleteMcpServer(id: string) {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  if (!id) throw new Error("MISSING_ID");
  const before = await loadRow(id);
  await prisma.mcpServer.delete({ where: { id } });
  await writeAudit({
    actor: session.user.id,
    action: "mcp_server.delete",
    objectType: "mcp_server",
    objectId: id,
    before: auditShape(before),
  });
  return { id };
}

export async function probeMcpServer(raw: unknown): Promise<McpProbeResult> {
  await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  const input = parse(mcpProbeSchema, raw);
  const verdict = checkServerUrl(input.url, input.internal);
  if (!verdict.ok) return failedProbe(verdict.code);
  const stored = input.id ? await prisma.mcpServer.findUnique({ where: { id: input.id }, select: serverSelect }) : null;
  const sameUrl = stored?.url === input.url;
  const storedSecret = stored?.authType === input.authType ? stored.authSecret : "";
  const authSecret = secretFor(input.authType, { secret: input.secret }, storedSecret);
  const record = serverRecord({
    id: stored?.id ?? "",
    name: stored?.name ?? "",
    url: input.url,
    authType: input.authType,
    authSecret,
    internal: input.internal,
    ...connectionFields(input),
    transport: sameUrl && stored ? stored.transport : "streamable_http",
    protocolVersion: sameUrl && stored ? stored.protocolVersion : "",
  });
  if (record.authType !== "oauth") return probe(record);
  const fetch = guardedFetch(record.internal);
  if (record.oauthGrant === "client_credentials") return probe(record, trialClientCredentials(record, fetch));
  const signedIn = sameUrl && stored?.authType === "oauth" && stored.oauthLogin?.status === "active";
  if (signedIn) return probe(record);
  try {
    await discoverOAuth({ url: record.url, scopes: record.oauthScopes, previousScope: "", offline: true }, fetch);
    return failedProbe("MCP_AUTH_REQUIRED");
  } catch (err) {
    return failedProbe(mcpErrorCode(err));
  }
}

export async function refreshMcpServer(id: string) {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  if (!id) throw new Error("MISSING_ID");
  const row = await loadRow(id);
  if (row.kind === "hosted") return { server: viewOf(row) };
  const result = await probe(serverRecord(row));
  const updated = await storeProbe(id, result);
  await writeAudit({
    actor: session.user.id,
    action: "mcp_server.refresh",
    objectType: "mcp_server",
    objectId: id,
    after: { connected: result.connected, tools: result.tools.length, error: result.error },
  });
  return { server: viewOf(updated) };
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
  return { server: viewOf(refreshed) };
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
  return { server: viewOf(await loadRow(id)) };
}

export async function loadMcpTargets() {
  await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  return { options: await targetOptions() };
}

export async function saveMcpAssignments(raw: unknown) {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  const input = parse(mcpAssignmentsSchema, raw);
  const before = await loadRow(input.serverId);
  const saved = await replaceMcpAssignments(input.serverId, input.global, input.assignments);
  if (!saved) throw new Error("NOT_FOUND");
  await writeAudit({
    actor: session.user.id,
    action: "mcp_server.assign",
    objectType: "mcp_server",
    objectId: input.serverId,
    before: { global: before.global, assignments: before.assignments.length },
    after: {
      global: saved.global,
      assignments: saved.assignments.map((row) => ({
        scope: row.scope,
        id: row.id,
        mode: row.mode,
        blockedTools: row.blockedTools,
        blockedActions: row.blockedActions,
      })),
    },
  });
  return { server: viewOf(await loadRow(input.serverId)) };
}
