import "server-only";
import prisma from "@/lib/db/prisma";
import type { KeyBindingRow, KeyTenancy } from "@/types/gateway";

const EMPTY: KeyTenancy = { userId: "", memberId: "", projectId: "", teamId: "", orgId: "" };

export function isInternalKey(row: Pick<KeyBindingRow, "memberId" | "projectId">): boolean {
  return !row.memberId && !row.projectId;
}

export async function resolveKeyTenancy(
  row: KeyBindingRow,
): Promise<{ tenancy: KeyTenancy; active: boolean }> {
  if (row.memberId) {
    const member = await prisma.member.findUnique({
      where: { id: row.memberId },
      select: { orgId: true, teamId: true, blocked: true },
    });
    return {
      tenancy: { ...EMPTY, memberId: row.memberId, teamId: member?.teamId ?? "", orgId: member?.orgId ?? "" },
      active: Boolean(member && !member.blocked),
    };
  }
  if (row.projectId) {
    const project = await prisma.project.findUnique({
      where: { id: row.projectId },
      select: { orgId: true, teamId: true },
    });
    return {
      tenancy: { ...EMPTY, projectId: row.projectId, teamId: project?.teamId ?? "", orgId: project?.orgId ?? "" },
      active: Boolean(project),
    };
  }
  const owner = row.userId
    ? await prisma.user.findUnique({
        where: { id: row.userId },
        select: { id: true, blocked: true, orgId: true },
      })
    : null;
  return {
    tenancy: { ...EMPTY, userId: owner?.id ?? "", orgId: owner?.orgId ?? "" },
    active: Boolean(owner && !owner.blocked),
  };
}
