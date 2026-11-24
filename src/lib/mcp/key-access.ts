import "server-only";
import prisma from "@/lib/db/prisma";
import { writeAudit } from "@/lib/audit";
import { AuthError } from "@/lib/auth/errors";
import { requireActor } from "@/lib/auth/guards";
import { companyOf, keyVisibleTo } from "@/lib/auth/scope";
import { resolveKeyTenancy } from "@/lib/gateway/access/key-tenancy";
import { assignmentData, assignmentViews, mcpAssignmentSelect } from "@/lib/mcp/assignments";
import { toolSpecs } from "@/lib/mcp/client";
import { classifyTools, cleanGrant, defaultAccessOf, toolActionsOf } from "@/lib/mcp/resolve";
import { serverKindOf } from "@/lib/mcp/toolset";
import { managesMcpRules, visibleToCompany } from "@/lib/mcp/scope";
import { keyMcpAccessSchema } from "@/schemas/mcp";
import type { Prisma } from "@/generated/prisma/client";
import type { AuthenticatedSession } from "@/types/auth";
import type { McpChain, McpKeyAccess, McpKeyServerAccess } from "@/types/mcp";

const serverSelect = {
  id: true,
  name: true,
  description: true,
  kind: true,
  enabled: true,
  template: true,
  global: true,
  globalAccess: true,
  toolsRestricted: true,
  allowedTools: true,
  tools: true,
  toolActions: true,
} as const;

type KeyRow = {
  id: string;
  keyAlias: string | null;
  prefix: string;
  userId: string | null;
  orgId: string | null;
  teamId: string | null;
  projectId: string | null;
  memberId: string | null;
};

function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("VALIDATION");
  return parsed.data;
}

async function mcpRulesSession(): Promise<{ session: AuthenticatedSession; company: string | null }> {
  const session = await requireActor();
  const company = companyOf(session);
  if (!managesMcpRules(session, company)) throw new AuthError("FORBIDDEN");
  return { session, company };
}

async function editableKey(keyId: unknown): Promise<{ session: AuthenticatedSession; key: KeyRow; company: string | null }> {
  const { session, company } = await mcpRulesSession();
  if (typeof keyId !== "string" || !keyId) throw new Error("MISSING_ID");
  const key = await prisma.virtualKey.findUnique({
    where: { id: keyId },
    select: { id: true, keyAlias: true, prefix: true, userId: true, orgId: true, teamId: true, projectId: true, memberId: true },
  });
  if (!key || !keyVisibleTo(session, key)) throw new Error("NOT_FOUND");
  return { session, key, company };
}

async function chainOfKey(key: KeyRow): Promise<McpChain> {
  const { tenancy } = await resolveKeyTenancy(key);
  return {
    orgId: tenancy.orgId || key.orgId || "",
    teamId: tenancy.teamId,
    projectId: tenancy.projectId,
    memberId: tenancy.memberId,
    keyId: key.id,
  };
}

function serverFilter(company: string | null): Prisma.McpServerWhereInput | undefined {
  return company ? visibleToCompany(company) : undefined;
}

function chainWhere(chain: McpChain): Prisma.McpAssignmentWhereInput[] {
  const where: Prisma.McpAssignmentWhereInput[] = [{ keyId: chain.keyId }];
  if (chain.orgId) where.push({ orgId: chain.orgId });
  if (chain.teamId) where.push({ teamId: chain.teamId });
  if (chain.projectId) where.push({ projectId: chain.projectId });
  if (chain.memberId) where.push({ memberId: chain.memberId });
  return where;
}

async function accessOf(key: KeyRow, company: string | null): Promise<McpKeyAccess> {
  const chain = await chainOfKey(key);
  const servers = await prisma.mcpServer.findMany({
    where: serverFilter(company),
    select: {
      ...serverSelect,
      installations: { where: { orgId: chain.orgId }, select: { enabled: true } },
      assignments: { where: { OR: chainWhere(chain) }, ...mcpAssignmentSelect },
    },
    orderBy: { name: "asc" },
  });
  return {
    keyId: key.id,
    label: key.keyAlias || key.prefix,
    company: chain.orgId,
    chain,
    servers: servers.map((server): McpKeyServerAccess => {
      const rules = assignmentViews(server.assignments);
      return {
        serverId: server.id,
        name: server.name,
        description: server.description,
        kind: serverKindOf(server.kind),
        enabled: server.enabled,
        template: server.template,
        connected: !server.template || server.installations.some((row) => row.enabled),
        defaultAccess: defaultAccessOf(server),
        toolsRestricted: server.toolsRestricted,
        allowedTools: server.allowedTools,
        tools: classifyTools(toolSpecs(server.tools), toolActionsOf(server.toolActions)),
        inherited: rules.filter((rule) => rule.scope !== "key"),
        rule: rules.find((rule) => rule.scope === "key") ?? null,
      };
    }),
  };
}

export async function loadKeyMcpAccess(keyId: unknown): Promise<McpKeyAccess> {
  const { key, company } = await editableKey(keyId);
  return accessOf(key, company);
}

export async function saveKeyMcpAccess(raw: unknown): Promise<McpKeyAccess> {
  await mcpRulesSession();
  const input = parse(keyMcpAccessSchema, raw);
  const { session, key, company } = await editableKey(input.keyId);
  const ids = [...new Set(input.servers.map((entry) => entry.serverId))];
  if (ids.length !== input.servers.length) throw new Error("VALIDATION");
  const servers = await prisma.mcpServer.findMany({
    where: { AND: [{ id: { in: ids } }, serverFilter(company) ?? {}] },
    select: { id: true, tools: true },
  });
  if (servers.length !== ids.length) throw new Error("NOT_FOUND");
  const byId = new Map(servers.map((server) => [server.id, server]));
  const rows: Prisma.McpAssignmentCreateManyInput[] = [];
  const summary: { serverId: string; access: string; extraTools: string[]; blockedTools: string[] }[] = [];
  for (const entry of input.servers) {
    const server = byId.get(entry.serverId)!;
    const known = new Set(toolSpecs(server.tools).map((tool) => tool.name));
    const grant = cleanGrant(entry, known);
    summary.push({
      serverId: entry.serverId,
      access: grant?.access ?? "inherit",
      extraTools: grant?.extraTools ?? [],
      blockedTools: grant?.blockedTools ?? [],
    });
    if (grant) rows.push(assignmentData(entry.serverId, { scope: "key", id: key.id, ...grant }));
  }
  await prisma.$transaction(async (tx) => {
    await tx.mcpAssignment.deleteMany({ where: { keyId: key.id, serverId: { in: ids } } });
    if (rows.length) await tx.mcpAssignment.createMany({ data: rows });
  });
  await writeAudit({
    actor: session.user.id,
    action: "mcp_key_access.save",
    objectType: "virtual_key",
    objectId: key.id,
    after: { servers: summary },
  });
  return accessOf(key, company);
}
