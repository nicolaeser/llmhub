import "server-only";
import prisma from "@/lib/db/prisma";
import { MCP_SCOPES } from "@/schemas/mcp";
import { toolSpecs } from "@/lib/mcp/client";
import { legacyColumns } from "@/lib/mcp/legacy-access";
import { cleanGrant, defaultAccessOf, ruleAccessOf } from "@/lib/mcp/resolve";
import type { Prisma } from "@/generated/prisma/client";
import type { McpAccessLevel, McpAssignmentInput, McpAssignmentSource, McpAssignmentView, McpTargetOptions } from "@/types/mcp";
import type { AssignmentScope } from "@/types/providers";

const OPTION_LIMIT = 1000;

const COLUMN = {
  org: "orgId",
  team: "teamId",
  project: "projectId",
  member: "memberId",
  key: "keyId",
} as const satisfies Record<AssignmentScope, string>;

export const mcpAssignmentSelect = {
  select: {
    orgId: true,
    teamId: true,
    projectId: true,
    memberId: true,
    keyId: true,
    access: true,
    extraTools: true,
    blockedTools: true,
    org: { select: { alias: true } },
    team: { select: { alias: true, orgId: true } },
    project: { select: { alias: true, orgId: true } },
    member: { select: { name: true, email: true, orgId: true } },
    key: { select: { keyAlias: true, prefix: true, orgId: true } },
  },
  orderBy: { createdAt: "asc" },
} as const;

function target(row: McpAssignmentSource): { scope: AssignmentScope; id: string; label: string } | null {
  if (row.keyId) return { scope: "key", id: row.keyId, label: row.key?.keyAlias || row.key?.prefix || row.keyId };
  if (row.memberId) return { scope: "member", id: row.memberId, label: row.member?.name || row.member?.email || row.memberId };
  if (row.projectId) return { scope: "project", id: row.projectId, label: row.project?.alias || row.projectId };
  if (row.teamId) return { scope: "team", id: row.teamId, label: row.team?.alias || row.teamId };
  if (row.orgId) return { scope: "org", id: row.orgId, label: row.org?.alias || row.orgId };
  return null;
}

export function assignmentViews(rows: McpAssignmentSource[]): McpAssignmentView[] {
  return rows.flatMap((row) => {
    const found = target(row);
    if (!found) return [];
    return [{ ...found, access: ruleAccessOf(row.access), extraTools: row.extraTools, blockedTools: row.blockedTools }];
  });
}

export async function targetOptions(): Promise<McpTargetOptions> {
  const [orgs, teams, projects, members, keys] = await Promise.all([
    prisma.organization.findMany({ select: { id: true, alias: true }, orderBy: { alias: "asc" } }),
    prisma.team.findMany({
      select: { id: true, alias: true, orgId: true, org: { select: { alias: true } } },
      orderBy: { alias: "asc" },
    }),
    prisma.project.findMany({
      select: { id: true, alias: true, orgId: true, teamId: true, org: { select: { alias: true } } },
      orderBy: { alias: "asc" },
    }),
    prisma.member.findMany({
      select: { id: true, name: true, email: true, orgId: true, teamId: true, org: { select: { alias: true } } },
      orderBy: { name: "asc" },
    }),
    prisma.virtualKey.findMany({
      select: {
        id: true,
        keyAlias: true,
        prefix: true,
        orgId: true,
        teamId: true,
        projectId: true,
        memberId: true,
        org: { select: { alias: true } },
      },
      orderBy: { createdAt: "desc" },
      take: OPTION_LIMIT,
    }),
  ]);
  const none = { orgId: "", teamId: "", projectId: "", memberId: "" };
  return {
    org: orgs.map((row) => ({ ...none, id: row.id, label: row.alias, detail: "" })),
    team: teams.map((row) => ({ ...none, id: row.id, label: row.alias, detail: row.org?.alias ?? "", orgId: row.orgId ?? "" })),
    project: projects.map((row) => ({
      ...none,
      id: row.id,
      label: row.alias,
      detail: row.org?.alias ?? "",
      orgId: row.orgId ?? "",
      teamId: row.teamId ?? "",
    })),
    member: members.map((row) => ({
      ...none,
      id: row.id,
      label: row.name || row.email,
      detail: row.org.alias,
      orgId: row.orgId,
      teamId: row.teamId ?? "",
    })),
    key: keys.map((row) => ({
      id: row.id,
      label: row.keyAlias || row.prefix,
      detail: row.org?.alias ?? row.prefix,
      orgId: row.orgId ?? "",
      teamId: row.teamId ?? "",
      projectId: row.projectId ?? "",
      memberId: row.memberId ?? "",
    })),
  };
}

function idsByScope(assignments: McpAssignmentInput[]): Record<AssignmentScope, string[]> {
  return Object.fromEntries(
    MCP_SCOPES.map((scope) => [scope, [...new Set(assignments.filter((row) => row.scope === scope).map((row) => row.id))]]),
  ) as Record<AssignmentScope, string[]>;
}

async function targetsExist(ids: Record<AssignmentScope, string[]>): Promise<boolean> {
  const counts = await Promise.all([
    prisma.organization.count({ where: { id: { in: ids.org } } }),
    prisma.team.count({ where: { id: { in: ids.team } } }),
    prisma.project.count({ where: { id: { in: ids.project } } }),
    prisma.member.count({ where: { id: { in: ids.member } } }),
    prisma.virtualKey.count({ where: { id: { in: ids.key } } }),
  ]);
  return MCP_SCOPES.every((scope, index) => counts[index] === ids[scope].length);
}

export function uniqueAssignments(assignments: McpAssignmentInput[], known?: ReadonlySet<string>): McpAssignmentInput[] {
  const seen = new Map<string, McpAssignmentInput>();
  for (const row of assignments) {
    const grant = cleanGrant(row, known);
    const key = `${row.scope}:${row.id}`;
    if (grant) seen.set(key, { scope: row.scope, id: row.id, ...grant });
    else seen.delete(key);
  }
  return [...seen.values()];
}

export function assignmentData(serverId: string, row: McpAssignmentInput): Prisma.McpAssignmentCreateManyInput {
  return {
    serverId,
    [COLUMN[row.scope]]: row.id,
    access: row.access,
    extraTools: row.extraTools,
    blockedTools: row.blockedTools,
    ...legacyColumns(row),
  };
}

export function defaultAccessData(level: McpAccessLevel): { global: boolean; globalAccess?: McpAccessLevel } {
  return level === "none" ? { global: false } : { global: true, globalAccess: level };
}

async function knownTools(serverId: string): Promise<Set<string> | null> {
  const server = await prisma.mcpServer.findUnique({ where: { id: serverId }, select: { tools: true } });
  return server ? new Set(toolSpecs(server.tools).map((tool) => tool.name)) : null;
}

type SavedAccess = { defaultAccess: McpAccessLevel; assignments: McpAssignmentView[] };

async function targetsInCompany(rows: McpAssignmentInput[], orgId: string): Promise<boolean> {
  const ids = idsByScope(rows);
  if (ids.org.some((id) => id !== orgId)) return false;
  const [teams, projects, members, keys] = await Promise.all([
    prisma.team.count({ where: { id: { in: ids.team }, orgId } }),
    prisma.project.count({ where: { id: { in: ids.project }, orgId } }),
    prisma.member.count({ where: { id: { in: ids.member }, orgId } }),
    prisma.virtualKey.count({ where: { id: { in: ids.key }, orgId } }),
  ]);
  return teams === ids.team.length && projects === ids.project.length && members === ids.member.length && keys === ids.key.length;
}

function holderOrg(row: {
  orgId: string | null;
  team: { orgId: string | null } | null;
  project: { orgId: string | null } | null;
  member: { orgId: string } | null;
  key: { orgId: string | null } | null;
}): string | null {
  return row.orgId || row.team?.orgId || row.project?.orgId || row.member?.orgId || row.key?.orgId || null;
}

export async function replaceMcpAssignments(
  serverId: string,
  defaultAccess: McpAccessLevel,
  assignments: McpAssignmentInput[],
): Promise<SavedAccess | null> {
  const known = await knownTools(serverId);
  if (!known) return null;
  const rows = uniqueAssignments(assignments, known);
  if (!(await targetsExist(idsByScope(rows)))) return null;
  const data = rows.map((row) => assignmentData(serverId, row));
  const saved = await prisma.$transaction(async (tx) => {
    const exists = await tx.mcpServer.findUnique({ where: { id: serverId }, select: { id: true } });
    if (!exists) return null;
    await tx.mcpAssignment.deleteMany({ where: { serverId } });
    if (data.length) await tx.mcpAssignment.createMany({ data });
    return tx.mcpServer.update({
      where: { id: serverId },
      data: defaultAccessData(defaultAccess),
      select: { global: true, globalAccess: true, assignments: mcpAssignmentSelect },
    });
  });
  return saved ? { defaultAccess: defaultAccessOf(saved), assignments: assignmentViews(saved.assignments) } : null;
}

export async function replaceCompanyMcpAssignments(
  serverId: string,
  orgId: string,
  assignments: McpAssignmentInput[],
): Promise<SavedAccess | null> {
  const known = await knownTools(serverId);
  if (!known) return null;
  const rows = uniqueAssignments(assignments, known);
  if (!(await targetsExist(idsByScope(rows)))) return null;
  if (!(await targetsInCompany(rows, orgId))) return null;
  const current = await prisma.mcpAssignment.findMany({
    where: { serverId },
    select: {
      id: true,
      orgId: true,
      team: { select: { orgId: true } },
      project: { select: { orgId: true } },
      member: { select: { orgId: true } },
      key: { select: { orgId: true } },
    },
  });
  const drop = current.filter((row) => holderOrg(row) === orgId).map((row) => row.id);
  const data = rows.map((row) => assignmentData(serverId, row));
  const saved = await prisma.$transaction(async (tx) => {
    const exists = await tx.mcpServer.findUnique({ where: { id: serverId }, select: { id: true } });
    if (!exists) return null;
    if (drop.length) await tx.mcpAssignment.deleteMany({ where: { id: { in: drop } } });
    if (data.length) await tx.mcpAssignment.createMany({ data });
    return tx.mcpServer.findUnique({
      where: { id: serverId },
      select: { global: true, globalAccess: true, assignments: mcpAssignmentSelect },
    });
  });
  return saved ? { defaultAccess: defaultAccessOf(saved), assignments: assignmentViews(saved.assignments) } : null;
}
