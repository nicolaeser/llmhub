import "server-only";
import prisma from "@/lib/db/prisma";
import { writeAudit } from "@/lib/audit";
import { AuthError, isPrismaCode } from "@/lib/auth/errors";
import { requireActor } from "@/lib/auth/guards";
import { companyOf } from "@/lib/auth/scope";
import { seal } from "@/lib/crypto";
import { toolSpecs } from "@/lib/mcp/client";
import { toolActionsOf } from "@/lib/mcp/resolve";
import { mcpAccess, requireMcpManager } from "@/lib/mcp/scope";
import { installedAuthType } from "@/lib/mcp/toolset";
import { checkServerUrl } from "@/lib/mcp/url-guard";
import { MCP_ROLE_KEYS, authUsesName, mcpInstallationSchema, mcpPermissionsSchema, mcpTemplateSchema } from "@/schemas/mcp";
import type { McpInstallationView, McpRoleView } from "@/types/mcp";

const BUILTIN_ROLES = [
  { key: "reader", name: "Reader", allActions: false, actions: ["read"] },
  { key: "operator", name: "Operator", allActions: false, actions: ["read", "write"] },
  { key: "admin", name: "Admin", allActions: true, actions: [] as string[] },
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
    allActions: boolean;
    actions: string[];
    tools: string[];
    deniedTools: string[];
    builtin: boolean;
    _count?: { assignments: number };
  }[],
): McpRoleView[] {
  const order: readonly string[] = MCP_ROLE_KEYS;
  const rank = (row: { key: string; builtin: boolean }) => (row.builtin ? order.indexOf(row.key) : order.length);
  return [...rows]
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .map((row) => ({
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description,
      allActions: row.allActions,
      actions: row.actions,
      tools: row.tools,
      deniedTools: row.deniedTools,
      builtin: row.builtin,
      assigned: row._count?.assignments ?? 0,
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
      authType: installedAuthType(row.authType),
      authHeader: row.authHeader,
      hasSecret: Boolean(row.authSecret),
    }));
}

export async function ensureMcpRoles(raw: unknown) {
  await requireMcpManager();
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
      allActions: role.allActions,
      actions: [...role.actions],
      tools: [],
      deniedTools: [],
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

function knownNames(names: string[], known: ReadonlySet<string>): string[] {
  return [...new Set(names)].filter((name) => known.has(name));
}

export async function saveMcpPermissions(raw: unknown) {
  const session = await requireMcpManager();
  const input = parse(mcpPermissionsSchema, raw);
  const server = await prisma.mcpServer.findUnique({
    where: { id: input.serverId },
    select: {
      id: true,
      tools: true,
      toolActions: true,
      roles: { select: { id: true, key: true, name: true, builtin: true, _count: { select: { assignments: true } } } },
    },
  });
  if (!server) throw new Error("NOT_FOUND");
  const known = new Set(toolSpecs(server.tools).map((tool) => tool.name));
  const current = new Map(server.roles.map((role) => [role.id, role]));
  const removed = [...new Set(input.removed)];
  for (const id of removed) {
    const role = current.get(id);
    if (!role || role.builtin) throw new Error("VALIDATION");
    if (role._count.assignments > 0) throw new Error("MCP_ROLE_IN_USE");
  }
  if (input.roles.some((role) => role.id && (!current.has(role.id) || removed.includes(role.id)))) {
    throw new Error("NOT_FOUND");
  }
  const toolActions = Object.fromEntries(Object.entries(input.toolActions).filter(([name]) => known.has(name)));
  const taken = new Set(server.roles.filter((role) => !removed.includes(role.id)).map((role) => role.key));
  const roles = input.roles.map((role) => {
    const existing = role.id ? current.get(role.id) : undefined;
    const key = existing?.key ?? nextRoleKey(role.name, taken);
    taken.add(key);
    const deniedTools = knownNames(role.deniedTools, known);
    const denied = new Set(deniedTools);
    return {
      id: existing?.id ?? "",
      key,
      name: existing?.builtin ? existing.name : role.name,
      grants: {
        description: role.description,
        allActions: role.allActions,
        actions: role.allActions ? [] : [...new Set(role.actions)],
        tools: knownNames(role.tools, known).filter((name) => !denied.has(name)),
        deniedTools,
      },
    };
  });
  try {
    await prisma.$transaction(async (tx) => {
      if (removed.length) {
        const inUse = await tx.mcpAssignment.count({ where: { roleId: { in: removed } } });
        if (inUse) throw new Error("MCP_ROLE_IN_USE");
        await tx.mcpRole.deleteMany({ where: { id: { in: removed }, serverId: server.id, builtin: false } });
      }
      await tx.mcpServer.update({ where: { id: server.id }, data: { toolActions } });
      for (const role of roles) {
        if (role.id) {
          await tx.mcpRole.update({ where: { id: role.id }, data: { ...role.grants, name: role.name } });
        } else {
          await tx.mcpRole.create({
            data: { serverId: server.id, key: role.key, name: role.name, builtin: false, ...role.grants },
          });
        }
      }
    });
  } catch (err) {
    if (isPrismaCode(err, "P2002")) throw new Error("NAME_EXISTS", { cause: err });
    throw err;
  }
  await writeAudit({
    actor: session.user.id,
    action: "mcp_server.permissions",
    objectType: "mcp_server",
    objectId: server.id,
    before: { toolActions: toolActionsOf(server.toolActions), roles: server.roles.map((role) => role.key) },
    after: {
      toolActions,
      roles: roles.map((role) => ({ role: role.key, ...role.grants })),
      removed: removed.map((id) => current.get(id)?.key ?? id),
    },
  });
  return { serverId: server.id };
}

export async function setMcpTemplate(raw: unknown) {
  const session = await requireMcpManager();
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
  const company = companyOf(session);
  if (!mcpAccess(session, company).canInstall) throw new AuthError("FORBIDDEN");
  const input = parse(mcpInstallationSchema, raw);
  if (company && company !== input.orgId) throw new AuthError("FORBIDDEN");
  const server = await prisma.mcpServer.findUnique({
    where: { id: input.serverId },
    select: { id: true, template: true, internal: true, kind: true },
  });
  if (!server) throw new Error("NOT_FOUND");
  if (!server.template) throw new Error("VALIDATION");
  if (input.authType === "query" && server.kind !== "hosted") throw new Error("VALIDATION");
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
      authHeader: authUsesName(input.authType) ? input.authHeader : "",
      authSecret,
    },
    update: {
      enabled: input.enabled,
      baseUrl: input.baseUrl,
      authType: input.authType,
      authHeader: authUsesName(input.authType) ? input.authHeader : "",
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
