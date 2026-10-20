import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/db/prisma";
import { writeAudit } from "@/lib/audit";
import { assignmentTargets } from "@/lib/gateway/routing/account-assignments";
import { subAddStatus } from "@/lib/providers/sub-add-status";
import type { AssignmentSource } from "@/types/providers";
import type { SubAddDeleteReason, SubAddLinkState } from "@/types/sub-add";

const PRUNE_BATCH = 50;

export const subAddAuditSelect = {
  id: true,
  label: true,
  kinds: true,
  maxAccounts: true,
  added: true,
  restricted: true,
  expiresAt: true,
  targets: { select: { orgId: true, teamId: true, projectId: true, memberId: true, keyId: true } },
} as const;

type AuditedLink = SubAddLinkState & {
  id: string;
  label: string;
  kinds: string[];
  restricted: boolean;
  expiresAt: Date;
  targets: AssignmentSource[];
};

export function subAddLinkAudit(row: AuditedLink, now = Date.now()) {
  return {
    label: row.label,
    kinds: row.kinds,
    maxAccounts: row.maxAccounts,
    added: row.added,
    restricted: row.restricted,
    targets: assignmentTargets(row.targets).map((target) => ({ scope: target.scope, id: target.id })),
    expiresAt: row.expiresAt.toISOString(),
    status: subAddStatus(row, now),
  };
}

export async function auditSubAddDelete(actor: string, row: AuditedLink, reason: SubAddDeleteReason): Promise<void> {
  await writeAudit({
    actor,
    action: "provider_sub_add.delete",
    objectType: "provider_sub_add",
    objectId: row.id,
    before: subAddLinkAudit(row),
    after: { reason },
  });
}

export function finishedSubAddLinks(now: Date): Prisma.SubAddLinkWhereInput {
  return {
    OR: [
      { expiresAt: { lte: now } },
      { maxAccounts: { not: null, lte: prisma.subAddLink.fields.added } },
    ],
  };
}

export async function pruneSubAddLinks(actor: string, now = Date.now()): Promise<string[]> {
  const rows = await prisma.subAddLink.findMany({
    where: finishedSubAddLinks(new Date(now)),
    select: subAddAuditSelect,
    orderBy: { createdAt: "asc" },
    take: PRUNE_BATCH,
  });
  const removed: string[] = [];
  for (const row of rows) {
    const deleted = await prisma.subAddLink.deleteMany({ where: { id: row.id } });
    if (!deleted.count) continue;
    removed.push(row.id);
    await auditSubAddDelete(actor, row, subAddStatus(row, now) === "used_up" ? "used_up" : "expired");
  }
  return removed;
}
