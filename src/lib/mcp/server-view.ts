import "server-only";
import prisma from "@/lib/db/prisma";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { companyOf } from "@/lib/auth/scope";
import { assignmentViews, mcpAssignmentSelect } from "@/lib/mcp/assignments";
import { managesMcp } from "@/lib/mcp/scope";
import { installationViews, roleViews } from "@/lib/mcp/catalog";
import { eraOf, toolSpecs } from "@/lib/mcp/client";
import { toolActionsOf } from "@/lib/mcp/resolve";
import { serverRecord } from "@/lib/mcp/toolset";
import type { Prisma } from "@/generated/prisma/client";
import type { AuthenticatedSession } from "@/types/auth";
import type { McpOAuthView, McpServerStatus, McpServerView } from "@/types/mcp";

export const serverSelect = {
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
  template: true,
  toolsRestricted: true,
  allowedTools: true,
  tools: true,
  toolActions: true,
  refreshedAt: true,
  lastError: true,
  updatedAt: true,
  assignments: mcpAssignmentSelect,
  roles: { orderBy: { name: "asc" }, include: { _count: { select: { assignments: true } } } },
  installations: {
    select: {
      id: true,
      orgId: true,
      enabled: true,
      baseUrl: true,
      authType: true,
      authHeader: true,
      authSecret: true,
      org: { select: { alias: true } },
    },
    orderBy: { org: { alias: "asc" } },
  },
  oauthLogin: { select: { status: true, scope: true, expiresAt: true, connectedAt: true, issuer: true, client: true } },
} as const satisfies Prisma.McpServerSelect;

export type ServerRow = Prisma.McpServerGetPayload<{ select: typeof serverSelect }>;

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

export function viewOf(row: ServerRow, canManage = true, companyId: string | null = null): McpServerView {
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
    template: row.template,
    toolsRestricted: row.toolsRestricted,
    allowedTools: row.allowedTools,
    tools: toolSpecs(row.tools),
    toolActions: toolActionsOf(row.toolActions),
    roles: roleViews(row.roles),
    installations: installationViews(row.installations, companyId),
    transport: record.transport,
    protocolVersion: row.protocolVersion,
    era: eraOf(record),
    refreshedAt: row.refreshedAt?.toISOString() ?? null,
    lastError: row.lastError,
    status: statusOf(row),
    assignments: assignmentViews(
      companyId
        ? row.assignments.filter(
            (assignment) =>
              assignment.orgId === companyId ||
              assignment.team?.orgId === companyId ||
              assignment.project?.orgId === companyId ||
              assignment.member?.orgId === companyId ||
              assignment.key?.orgId === companyId,
          )
        : row.assignments,
    ),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function seesMcp(session: Pick<AuthenticatedSession, "permissions">): boolean {
  return hasPerm(session.permissions, PERMISSIONS.SETTINGS_READ) || hasPerm(session.permissions, PERMISSIONS.MCP_READ);
}

export function scopedView(row: ServerRow, session: AuthenticatedSession): McpServerView {
  return viewOf(row, managesMcp(session), companyOf(session));
}

export async function loadRow(id: string): Promise<ServerRow> {
  const row = await prisma.mcpServer.findUnique({ where: { id }, select: serverSelect });
  if (!row) throw new Error("NOT_FOUND");
  return row;
}

export function auditShape(
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
