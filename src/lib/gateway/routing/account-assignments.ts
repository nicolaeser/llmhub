import "server-only";
import prisma from "@/lib/db/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { ASSIGNMENT_SCOPES } from "@/lib/gateway/routing/account-access";
import type { AssignmentInput, AssignmentOptions, AssignmentScope, AssignmentSource, AssignmentTarget } from "@/types/providers";

const OPTION_LIMIT = 1000;

export const assignmentSelect = {
  select: {
    orgId: true,
    teamId: true,
    projectId: true,
    memberId: true,
    keyId: true,
    org: { select: { alias: true } },
    team: { select: { alias: true } },
    project: { select: { alias: true } },
    member: { select: { name: true, email: true } },
    key: { select: { keyAlias: true, prefix: true } },
  },
  orderBy: { createdAt: "asc" },
} as const;

const COLUMN = {
  org: "orgId",
  team: "teamId",
  project: "projectId",
  member: "memberId",
  key: "keyId",
} as const satisfies Record<AssignmentScope, string>;

export function assignmentTargets(rows: AssignmentSource[]): AssignmentTarget[] {
  return rows.flatMap((row): AssignmentTarget[] => {
    if (row.keyId) return [{ scope: "key", id: row.keyId, label: row.key?.keyAlias || row.key?.prefix || row.keyId }];
    if (row.memberId) {
      return [{ scope: "member", id: row.memberId, label: row.member?.name || row.member?.email || row.memberId }];
    }
    if (row.projectId) return [{ scope: "project", id: row.projectId, label: row.project?.alias || row.projectId }];
    if (row.teamId) return [{ scope: "team", id: row.teamId, label: row.team?.alias || row.teamId }];
    if (row.orgId) return [{ scope: "org", id: row.orgId, label: row.org?.alias || row.orgId }];
    return [];
  });
}

export async function assignmentOptions(): Promise<AssignmentOptions> {
  const [orgs, teams, projects, members, keys] = await Promise.all([
    prisma.organization.findMany({ select: { id: true, alias: true }, orderBy: { alias: "asc" } }),
    prisma.team.findMany({ select: { id: true, alias: true, org: { select: { alias: true } } }, orderBy: { alias: "asc" } }),
    prisma.project.findMany({
      select: { id: true, alias: true, org: { select: { alias: true } } },
      orderBy: { alias: "asc" },
    }),
    prisma.member.findMany({
      select: { id: true, name: true, email: true, org: { select: { alias: true } } },
      orderBy: { name: "asc" },
    }),
    prisma.virtualKey.findMany({
      select: { id: true, keyAlias: true, prefix: true, org: { select: { alias: true } } },
      orderBy: { createdAt: "desc" },
      take: OPTION_LIMIT,
    }),
  ]);
  return {
    org: orgs.map((row) => ({ id: row.id, label: row.alias })),
    team: teams.map((row) => ({ id: row.id, label: row.alias, detail: row.org?.alias ?? "" })),
    project: projects.map((row) => ({ id: row.id, label: row.alias, detail: row.org?.alias ?? "" })),
    member: members.map((row) => ({ id: row.id, label: row.name || row.email, detail: row.org.alias })),
    key: keys.map((row) => ({ id: row.id, label: row.keyAlias || row.prefix, detail: row.org?.alias ?? row.prefix })),
  };
}

function idsOf(targets: AssignmentInput[], scope: AssignmentScope): string[] {
  return [...new Set(targets.filter((target) => target.scope === scope).map((target) => target.id))];
}

function targetIds(targets: AssignmentInput[]): Record<AssignmentScope, string[]> {
  return Object.fromEntries(ASSIGNMENT_SCOPES.map((scope) => [scope, idsOf(targets, scope)])) as Record<
    AssignmentScope,
    string[]
  >;
}

export function assignmentColumns(targets: AssignmentInput[]): Partial<Record<(typeof COLUMN)[AssignmentScope], string>>[] {
  const ids = targetIds(targets);
  return ASSIGNMENT_SCOPES.flatMap((scope) => ids[scope].map((id) => ({ [COLUMN[scope]]: id })));
}

export async function targetsMissing(targets: AssignmentInput[]): Promise<boolean> {
  return missingTargets(targetIds(targets));
}

async function missingTargets(ids: Record<AssignmentScope, string[]>): Promise<boolean> {
  const counts = await Promise.all([
    prisma.organization.count({ where: { id: { in: ids.org } } }),
    prisma.team.count({ where: { id: { in: ids.team } } }),
    prisma.project.count({ where: { id: { in: ids.project } } }),
    prisma.member.count({ where: { id: { in: ids.member } } }),
    prisma.virtualKey.count({ where: { id: { in: ids.key } } }),
  ]);
  return ASSIGNMENT_SCOPES.some((scope, index) => counts[index] !== ids[scope].length);
}

export async function replaceAssignments(
  providerId: string,
  restricted: boolean,
  targets: AssignmentInput[],
): Promise<{ restricted: boolean; assignments: AssignmentTarget[] } | null> {
  if (await targetsMissing(targets)) return null;
  const data: Prisma.ProviderAssignmentCreateManyInput[] = assignmentColumns(targets).map((columns) => ({
    providerId,
    ...columns,
  }));
  const row = await prisma.$transaction(async (tx) => {
    const exists = await tx.providerConnection.findUnique({ where: { id: providerId }, select: { id: true } });
    if (!exists) return null;
    await tx.providerAssignment.deleteMany({ where: { providerId } });
    if (data.length) await tx.providerAssignment.createMany({ data });
    return tx.providerConnection.update({
      where: { id: providerId },
      data: { restricted },
      select: { restricted: true, assignments: assignmentSelect },
    });
  });
  return row ? { restricted: row.restricted, assignments: assignmentTargets(row.assignments) } : null;
}
