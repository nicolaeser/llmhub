import "server-only";
import prisma from "@/lib/db/prisma";
import { writeAudit } from "@/lib/audit";
import { AuthError, isPrismaCode } from "@/lib/auth/errors";
import { requireActor } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { companyOf } from "@/lib/auth/scope";
import { seal } from "@/lib/crypto";
import { checkServerUrl } from "@/lib/mcp/url-guard";
import { MCP_ROLE_KEYS, mcpInstallationSchema, mcpRoleSchema, mcpTemplateSchema } from "@/schemas/mcp";
import type { McpInstallationView, McpRoleView } from "@/types/mcp";

const BUILTIN_ROLES = [
  { key: "reader", name: "Reader", allTools: true, allActions: false, actions: ["read"] },
  { key: "operator", name: "Operator", allTools: true, allActions: false, actions: ["read", "write"] },
  { key: "admin", name: "Admin", allTools: true, allActions: true, actions: [] as string[] },
] as const;

function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("VALIDATION");
  return parsed.data;
}

export function roleViews(
  rows: {
    id: string;
    key: string;
    name: string;
    description: string;
    allTools: boolean;
    tools: string[];
    allActions: boolean;
    actions: string[];
    builtin: boolean;
  }[],
): McpRoleView[] {
  return [...rows]
    .sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name))
    .map((row) => ({
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description,
      allTools: row.allTools,
      tools: row.tools,
      allActions: row.allActions,
      actions: row.actions,
      builtin: row.builtin,
    }));
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
      authType: row.authType === "none" || row.authType === "header" ? row.authType : "bearer",
      authHeader: row.authHeader,
      hasSecret: Boolean(row.authSecret),
    }));
}

export async function ensureMcpRoles(raw: unknown) {
  await requireCatalogManager();
  const id = typeof raw === "string" ? raw : "";
  if (!id) throw new Error("VALIDATION");
  const server = await prisma.mcpServer.findUnique({ where: { id }, select: { id: true } });
  if (!server) throw new Error("NOT_FOUND");
  await ensureBuiltinRoles(server.id);
  return { serverId: server.id };
}

export async function ensureBuiltinRoles(serverId: string): Promise<void> {
  await prisma.mcpRole.createMany({
    data: BUILTIN_ROLES.map((role) => ({
      serverId,
      key: role.key,
      name: role.name,
      description: "",
      allTools: role.allTools,
      tools: [],
      allActions: role.allActions,
      actions: [...role.actions],
      builtin: true,
    })),
    skipDuplicates: true,
  });
}

function nextRoleKey(name: string, taken: ReadonlySet<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24) || "role";
  let key = (MCP_ROLE_KEYS as readonly string[]).includes(base) ? `${base}_custom` : base;
  let n = 2;
  while (taken.has(key)) {
    key = `${base}_${n}`.slice(0, 32);
    n += 1;
  }
  return key;
}

async function requireCatalogManager() {
  const session = await requireActor();
  if (!hasPerm(session.permissions, PERMISSIONS.MCP_MANAGE) && !hasPerm(session.permissions, PERMISSIONS.SETTINGS_MANAGE)) {
    throw new AuthError("FORBIDDEN");
  }
  return session;
}

export async function saveMcpRole(raw: unknown) {
  const session = await requireCatalogManager();
  const input = parse(mcpRoleSchema, raw);
  const server = await prisma.mcpServer.findUnique({ where: { id: input.serverId }, select: { id: true } });
  if (!server) throw new Error("NOT_FOUND");
  const grants = {
    description: input.description,
    allTools: input.allTools,
    tools: input.allTools ? [] : [...new Set(input.tools)],
    allActions: input.allActions,
    actions: input.allActions ? [] : [...new Set(input.actions)],
  };
  if (input.id) {
    const role = await prisma.mcpRole.findFirst({ where: { id: input.id, serverId: input.serverId } });
    if (!role) throw new Error("NOT_FOUND");
    await prisma.mcpRole.update({
      where: { id: role.id },
      data: { ...grants, name: role.builtin ? role.name : input.name },
    });
    await writeAudit({
      actor: session.user.id,
      action: "mcp_role.update",
      objectType: "mcp_server",
      objectId: input.serverId,
      after: { role: role.key, ...grants },
    });
    return { serverId: input.serverId };
  }
  const existing = await prisma.mcpRole.findMany({ where: { serverId: input.serverId }, select: { key: true } });
  const key = nextRoleKey(input.name, new Set(existing.map((row) => row.key)));
  try {
    await prisma.mcpRole.create({
      data: { serverId: input.serverId, key, name: input.name, builtin: false, ...grants },
    });
  } catch (err) {
    if (isPrismaCode(err, "P2002")) throw new Error("NAME_EXISTS", { cause: err });
    throw err;
  }
  await writeAudit({
    actor: session.user.id,
    action: "mcp_role.create",
    objectType: "mcp_server",
    objectId: input.serverId,
    after: { role: key, name: input.name },
  });
  return { serverId: input.serverId };
}

export async function deleteMcpRole(raw: unknown) {
  const session = await requireCatalogManager();
  const id = typeof raw === "string" ? raw : "";
  if (!id) throw new Error("VALIDATION");
  const role = await prisma.mcpRole.findUnique({ where: { id }, select: { id: true, serverId: true, key: true, builtin: true } });
  if (!role) throw new Error("NOT_FOUND");
  if (role.builtin) throw new Error("VALIDATION");
  await prisma.mcpRole.delete({ where: { id: role.id } });
  await writeAudit({
    actor: session.user.id,
    action: "mcp_role.delete",
    objectType: "mcp_server",
    objectId: role.serverId,
    before: { role: role.key },
  });
  return { serverId: role.serverId };
}

export async function setMcpTemplate(raw: unknown) {
  const session = await requireCatalogManager();
  const input = parse(mcpTemplateSchema, raw);
  const server = await prisma.mcpServer.findUnique({ where: { id: input.id }, select: { id: true, template: true } });
  if (!server) throw new Error("NOT_FOUND");
  if (input.template) await ensureBuiltinRoles(server.id);
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
  const canManage = hasPerm(session.permissions, PERMISSIONS.MCP_MANAGE);
  const canInstall = hasPerm(session.permissions, PERMISSIONS.MCP_INSTALL);
  if (!canManage && !canInstall) throw new AuthError("FORBIDDEN");
  const input = parse(mcpInstallationSchema, raw);
  const company = companyOf(session);
  if (company && company !== input.orgId) throw new AuthError("FORBIDDEN");
  const server = await prisma.mcpServer.findUnique({
    where: { id: input.serverId },
    select: { id: true, template: true, internal: true, kind: true },
  });
  if (!server) throw new Error("NOT_FOUND");
  if (!server.template) throw new Error("VALIDATION");
  if (input.baseUrl) {
    const verdict = checkServerUrl(input.baseUrl, server.internal);
    if (!verdict.ok) throw new Error(verdict.code);
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
      authHeader: input.authType === "header" ? input.authHeader : "",
      authSecret,
    },
    update: {
      enabled: input.enabled,
      baseUrl: input.baseUrl,
      authType: input.authType,
      authHeader: input.authType === "header" ? input.authHeader : "",
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
  return { serverId: input.serverId };
}
