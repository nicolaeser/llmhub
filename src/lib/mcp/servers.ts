import "server-only";
import prisma from "@/lib/db/prisma";
import { requirePermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { isPrismaCode } from "@/lib/auth/errors";
import { writeAudit } from "@/lib/audit";
import { seal } from "@/lib/crypto";
import { assignmentViews, mcpAssignmentSelect, replaceMcpAssignments, targetOptions } from "@/lib/mcp/assignments";
import { McpClient, toolSpecs } from "@/lib/mcp/client";
import { McpError, mcpErrorCode } from "@/lib/mcp/errors";
import { authHeaders, isAuthType } from "@/lib/mcp/toolset";
import { guardedFetch } from "@/lib/mcp/transport";
import { checkServerUrl } from "@/lib/mcp/url-guard";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { mcpAssignmentsSchema, mcpProbeSchema, mcpServerInputSchema } from "@/schemas/mcp";
import type { Prisma } from "@/generated/prisma/client";
import type { McpAuthType, McpProbeResult, McpServerStatus, McpServerView } from "@/types/mcp";

const PROBE_TIMEOUT_MS = 20_000;

const serverSelect = {
  id: true,
  name: true,
  description: true,
  url: true,
  authType: true,
  authHeader: true,
  authSecret: true,
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
} as const satisfies Prisma.McpServerSelect;

type ServerRow = Prisma.McpServerGetPayload<{ select: typeof serverSelect }>;

function statusOf(row: Pick<ServerRow, "enabled" | "lastError" | "refreshedAt">): McpServerStatus {
  if (!row.enabled) return "disabled";
  if (row.lastError) return "error";
  return row.refreshedAt ? "connected" : "unchecked";
}

function shownUrl(url: string): string {
  return URL.canParse(url) ? new URL(url).origin : "";
}

function viewOf(row: ServerRow, canManage = true): McpServerView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    url: canManage ? row.url : shownUrl(row.url),
    authType: isAuthType(row.authType) ? row.authType : "none",
    authHeader: row.authHeader,
    hasSecret: Boolean(row.authSecret),
    internal: row.internal,
    enabled: row.enabled,
    global: row.global,
    toolsRestricted: row.toolsRestricted,
    allowedTools: row.allowedTools,
    tools: toolSpecs(row.tools),
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

async function probe(input: {
  url: string;
  authType: McpAuthType;
  authHeader: string;
  authSecret: string;
  internal: boolean;
}): Promise<McpProbeResult> {
  const client = new McpClient({
    url: input.url,
    headers: authHeaders(input),
    fetch: guardedFetch(input.internal),
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  try {
    const serverName = await client.initialize();
    const tools = await client.listTools();
    return { connected: true, tools, serverName, error: "" };
  } catch (err) {
    const code = mcpErrorCode(err);
    logger.warn("mcp.probe_failed", { code, ...(err instanceof McpError ? {} : errorFields(err)) });
    return { connected: false, tools: [], serverName: "", error: code };
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
      ? { tools: result.tools as unknown as Prisma.InputJsonValue, refreshedAt: new Date(), lastError: "" }
      : { lastError: result.error },
    select: serverSelect,
  });
}

function secretFor(authType: McpAuthType, input: { secret: string; clearSecret?: boolean }, current: string): string {
  if (authType === "none") return "";
  if (input.secret.trim()) return seal(input.secret.trim());
  if (input.clearSecret) return "";
  return current;
}

function auditShape(row: Pick<ServerRow, "name" | "url" | "authType" | "authHeader" | "authSecret" | "internal" | "enabled" | "global" | "toolsRestricted" | "allowedTools">) {
  return {
    name: row.name,
    url: row.url,
    authType: row.authType,
    authHeader: row.authHeader,
    hasSecret: Boolean(row.authSecret),
    internal: row.internal,
    enabled: row.enabled,
    global: row.global,
    toolsRestricted: row.toolsRestricted,
    allowedTools: row.allowedTools,
  };
}

export async function loadMcpServerList() {
  const session = await requirePermission(PERMISSIONS.SETTINGS_READ);
  const rows = await prisma.mcpServer.findMany({ select: serverSelect, orderBy: { name: "asc" } });
  const canManage = hasPerm(session.permissions, PERMISSIONS.SETTINGS_MANAGE);
  return { servers: rows.map((row) => viewOf(row, canManage)), canManage };
}

export async function createMcpServer(raw: unknown) {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  const input = parse(mcpServerInputSchema, raw);
  assertUrl(input.url, input.internal);
  const authSecret = secretFor(input.authType, input, "");
  if (input.authType !== "none" && !authSecret) throw new Error("MCP_SECRET_REQUIRED");
  let created: ServerRow;
  try {
    created = await prisma.mcpServer.create({
      data: {
        name: input.name,
        description: input.description,
        url: input.url,
        authType: input.authType,
        authHeader: input.authType === "header" ? input.authHeader : "",
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
  const refreshed = await storeProbe(created.id, await probe({ ...created, authType: input.authType }));
  return { server: viewOf(refreshed) };
}

export async function updateMcpServer(raw: { id: string } & Record<string, unknown>) {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  if (!raw?.id || typeof raw.id !== "string") throw new Error("MISSING_ID");
  const input = parse(mcpServerInputSchema, raw);
  assertUrl(input.url, input.internal);
  const before = await loadRow(raw.id);
  const authSecret = secretFor(input.authType, input, before.authSecret);
  if (input.authType !== "none" && !authSecret) throw new Error("MCP_SECRET_REQUIRED");
  const authHeader = input.authType === "header" ? input.authHeader : "";
  const connectionChanged =
    before.url !== input.url ||
    before.authType !== input.authType ||
    before.authHeader !== authHeader ||
    before.authSecret !== authSecret ||
    before.internal !== input.internal;
  let updated: ServerRow;
  try {
    updated = await prisma.mcpServer.update({
      where: { id: raw.id },
      data: {
        name: input.name,
        description: input.description,
        url: input.url,
        authType: input.authType,
        authHeader,
        authSecret,
        internal: input.internal,
        enabled: input.enabled,
        global: input.global,
        toolsRestricted: input.toolsRestricted,
        allowedTools: [...new Set(input.allowedTools)],
        ...(connectionChanged ? { lastError: "", refreshedAt: null } : {}),
        ...(before.url !== input.url ? { tools: [] } : {}),
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
  if (!updated.enabled) return { server: viewOf(updated) };
  const refreshed = await storeProbe(updated.id, await probe({ ...updated, authType: input.authType }));
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
  if (!verdict.ok) return { connected: false, tools: [], serverName: "", error: verdict.code };
  let authSecret = input.authType === "none" ? "" : input.secret.trim() ? seal(input.secret.trim()) : "";
  if (input.authType !== "none" && !authSecret && input.id) {
    const stored = await prisma.mcpServer.findUnique({ where: { id: input.id }, select: { authSecret: true } });
    authSecret = stored?.authSecret ?? "";
  }
  return probe({
    url: input.url,
    authType: input.authType,
    authHeader: input.authType === "header" ? input.authHeader : "",
    authSecret,
    internal: input.internal,
  });
}

export async function refreshMcpServer(id: string) {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  if (!id) throw new Error("MISSING_ID");
  const row = await loadRow(id);
  const result = await probe({ ...row, authType: isAuthType(row.authType) ? row.authType : "none" });
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
      })),
    },
  });
  return { server: viewOf(await loadRow(input.serverId)) };
}
