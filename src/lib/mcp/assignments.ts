import "server-only";
import prisma from "@/lib/db/prisma";
import { MCP_SCOPES } from "@/schemas/mcp";
import { isAssignmentMode } from "@/lib/mcp/toolset";
import type { Prisma } from "@/generated/prisma/client";
import type { McpAssignmentInput, McpAssignmentSource, McpAssignmentView, McpTargetOptions } from "@/types/mcp";
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
    mode: true,
    blockedTools: true,
    blockedActions: true,
    org: { select: { alias: true } },
    team: { select: { alias: true } },
    project: { select: { alias: true } },
    member: { select: { name: true, email: true } },
    key: { select: { keyAlias: true, prefix: true } },
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
    return [{
      ...found,
      mode: isAssignmentMode(row.mode) ? row.mode : "block",
      blockedTools: row.blockedTools,
      blockedActions: Array.isArray(row.blockedActions) ? row.blockedActions : [],
    }];
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

export function uniqueAssignments(assignments: McpAssignmentInput[]): McpAssignmentInput[] {
  const seen = new Map<string, McpAssignmentInput>();
  for (const row of assignments) {
    seen.set(`${row.scope}:${row.id}`, {
      ...row,
      blockedTools: [...new Set(row.blockedTools)],
      blockedActions: [...new Set(row.blockedActions)],
    });
  }
  return [...seen.values()];
}

export async function replaceMcpAssignments(
  serverId: string,
  global: boolean,
  assignments: McpAssignmentInput[],
): Promise<{ global: boolean; assignments: McpAssignmentView[] } | null> {
  const rows = uniqueAssignments(assignments);
  if (!(await targetsExist(idsByScope(rows)))) return null;
  const data: Prisma.McpAssignmentCreateManyInput[] = rows.map((row) => ({
    serverId,
    [COLUMN[row.scope]]: row.id,
    mode: row.mode,
    blockedTools: row.blockedTools,
    blockedActions: row.blockedActions,
  }));
  const saved = await prisma.$transaction(async (tx) => {
    const exists = await tx.mcpServer.findUnique({ where: { id: serverId }, select: { id: true } });
    if (!exists) return null;
    await tx.mcpAssignment.deleteMany({ where: { serverId } });
    if (data.length) await tx.mcpAssignment.createMany({ data });
    return tx.mcpServer.update({
      where: { id: serverId },
      data: { global },
      select: { global: true, assignments: mcpAssignmentSelect },
    });
  });
  return saved ? { global: saved.global, assignments: assignmentViews(saved.assignments) } : null;
}
