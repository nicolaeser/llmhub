import "server-only";
import prisma from "@/lib/db/prisma";
import { writeAudit } from "@/lib/audit";
import { AuthError } from "@/lib/auth/errors";
import { requireActor } from "@/lib/auth/guards";
import { companyOf } from "@/lib/auth/scope";
import { seal } from "@/lib/crypto";
import { toolSpecs } from "@/lib/mcp/client";
import { toolActionsOf } from "@/lib/mcp/resolve";
import { mcpAccess, requireMcpManager } from "@/lib/mcp/scope";
import { installedAuthType } from "@/lib/mcp/toolset";
import { checkServerUrl } from "@/lib/mcp/url-guard";
import { authNameValid, authUsesName, installedAuthName, mcpInstallationSchema, mcpPermissionsSchema, mcpTemplateSchema } from "@/schemas/mcp";
import type { McpInstallationView } from "@/types/mcp";

function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("VALIDATION");
  return parsed.data;
}

export function installationViews(
  rows: {
    id: string;
    orgId: string;
    enabled: boolean;
    baseUrl: string;
    authType: string;
    authHeader: string;
    authSecret: string;
    org: { alias: string } | null;
  }[],
  companyId: string | null,
): McpInstallationView[] {
  return rows
    .filter((row) => !companyId || row.orgId === companyId)
    .map((row) => ({
      id: row.id,
      orgId: row.orgId,
      orgLabel: row.org?.alias || row.orgId,
      enabled: row.enabled,
      baseUrl: row.baseUrl,
      authType: installedAuthType(row.authType),
      authHeader: row.authHeader,
      hasSecret: Boolean(row.authSecret),
    }));
}

export async function saveMcpPermissions(raw: unknown) {
  const session = await requireMcpManager();
  const input = parse(mcpPermissionsSchema, raw);
  const server = await prisma.mcpServer.findUnique({
    where: { id: input.serverId },
    select: { id: true, tools: true, toolActions: true },
  });
  if (!server) throw new Error("NOT_FOUND");
  const known = new Set(toolSpecs(server.tools).map((tool) => tool.name));
  const toolActions = Object.fromEntries(Object.entries(input.toolActions).filter(([name]) => known.has(name)));
  await prisma.mcpServer.update({ where: { id: server.id }, data: { toolActions } });
  await writeAudit({
    actor: session.user.id,
    action: "mcp_server.permissions",
    objectType: "mcp_server",
    objectId: server.id,
    before: { toolActions: toolActionsOf(server.toolActions) },
    after: { toolActions },
  });
  return { serverId: server.id };
}

export async function setMcpTemplate(raw: unknown) {
  const session = await requireMcpManager();
  const input = parse(mcpTemplateSchema, raw);
  const server = await prisma.mcpServer.findUnique({ where: { id: input.id }, select: { id: true, template: true, kind: true } });
  if (!server) throw new Error("NOT_FOUND");
  if (input.template && server.kind === "media") throw new Error("VALIDATION");
  await prisma.mcpServer.update({ where: { id: server.id }, data: { template: input.template } });
  await writeAudit({
    actor: session.user.id,
    action: "mcp_server.template",
    objectType: "mcp_server",
    objectId: server.id,
    before: { template: server.template },
    after: { template: input.template },
  });
  return { serverId: server.id };
}

export async function saveMcpInstallation(raw: unknown) {
  const session = await requireActor();
  const company = companyOf(session);
  if (!mcpAccess(session, company).canInstall) throw new AuthError("FORBIDDEN");
  const input = parse(mcpInstallationSchema, raw);
  if (company && company !== input.orgId) throw new AuthError("FORBIDDEN");
  const server = await prisma.mcpServer.findUnique({
    where: { id: input.serverId },
    select: { id: true, template: true, internal: true, kind: true, authType: true, authHeader: true },
  });
  if (!server) throw new Error("NOT_FOUND");
  if (!server.template || server.kind === "media") throw new Error("VALIDATION");
  if (input.baseUrl) {
    const verdict = checkServerUrl(input.baseUrl, server.internal);
    if (!verdict.ok) throw new Error(verdict.code);
  }
  const authHeader = authUsesName(input.authType) ? input.authHeader : "";
  if (!authNameValid(input.authType, authHeader || installedAuthName(input.authType, "", server))) {
    throw new Error("VALIDATION");
  }
  const previous = await prisma.mcpInstallation.findUnique({
    where: { serverId_orgId: { serverId: input.serverId, orgId: input.orgId } },
    select: { authSecret: true, authType: true },
  });
  let authSecret = previous && previous.authType === input.authType ? previous.authSecret : "";
  if (input.authType === "none") authSecret = "";
  if (input.secret.trim()) authSecret = seal(input.secret.trim());
  if (input.enabled && input.authType !== "none" && !authSecret) throw new Error("MCP_SECRET_REQUIRED");
  await prisma.mcpInstallation.upsert({
    where: { serverId_orgId: { serverId: input.serverId, orgId: input.orgId } },
    create: {
      serverId: input.serverId,
      orgId: input.orgId,
      enabled: input.enabled,
      baseUrl: input.baseUrl,
      authType: input.authType,
      authHeader,
      authSecret,
    },
    update: {
      enabled: input.enabled,
      baseUrl: input.baseUrl,
      authType: input.authType,
      authHeader,
      authSecret,
    },
  });
  await writeAudit({
    actor: session.user.id,
    action: "mcp_installation.save",
    objectType: "mcp_server",
    objectId: input.serverId,
    after: { orgId: input.orgId, enabled: input.enabled, authType: input.authType, hosted: server.kind === "hosted" },
  });
  return { serverId: input.serverId, orgId: input.orgId };
}
