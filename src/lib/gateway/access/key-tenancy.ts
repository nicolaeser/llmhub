import "server-only";
import prisma from "@/lib/db/prisma";
import { longestPause, rowPause } from "@/lib/keys/pause";
import type { KeyBindingRow, KeyTenancy } from "@/types/keys";
import type { HeldPause } from "@/types/structure";

const EMPTY: KeyTenancy = { userId: "", memberId: "", projectId: "", teamId: "", orgId: "" };

const PAUSE_SELECT = { paused: true, pausedUntil: true } as const;

export function isInternalKey(row: Pick<KeyBindingRow, "memberId" | "projectId">): boolean {
  return !row.memberId && !row.projectId;
}

export async function resolveKeyTenancy(
  row: KeyBindingRow,
  now = new Date(),
): Promise<{ tenancy: KeyTenancy; active: boolean; pause: HeldPause | null }> {
  if (row.memberId) {
    const member = await prisma.member.findUnique({
      where: { id: row.memberId },
      select: { orgId: true, teamId: true, blocked: true, ...PAUSE_SELECT },
    });
    return {
      tenancy: { ...EMPTY, memberId: row.memberId, teamId: member?.teamId ?? "", orgId: member?.orgId ?? "" },
      active: Boolean(member && !member.blocked),
      pause: rowPause("member", member, now),
    };
  }
  if (row.projectId) {
    const project = await prisma.project.findUnique({
      where: { id: row.projectId },
      select: { orgId: true, teamId: true, ...PAUSE_SELECT },
    });
    return {
      tenancy: { ...EMPTY, projectId: row.projectId, teamId: project?.teamId ?? "", orgId: project?.orgId ?? "" },
      active: Boolean(project),
      pause: rowPause("project", project, now),
    };
  }
  const owner = row.userId
    ? await prisma.user.findUnique({
        where: { id: row.userId },
        select: { id: true, blocked: true, credentialsSuspendedAt: true, orgId: true },
      })
    : null;
  return {
    tenancy: { ...EMPTY, userId: owner?.id ?? "", orgId: owner?.orgId ?? "" },
    active: Boolean(owner && !owner.blocked && !owner.credentialsSuspendedAt),
    pause: null,
  };
}

export async function placePause(
  tenancy: Pick<KeyTenancy, "teamId" | "orgId">,
  now = new Date(),
): Promise<HeldPause | null> {
  const [team, org] = await Promise.all([
    tenancy.teamId ? prisma.team.findUnique({ where: { id: tenancy.teamId }, select: PAUSE_SELECT }) : null,
    tenancy.orgId ? prisma.organization.findUnique({ where: { id: tenancy.orgId }, select: PAUSE_SELECT }) : null,
  ]);
  return longestPause([rowPause("team", team, now), rowPause("org", org, now)]);
}
