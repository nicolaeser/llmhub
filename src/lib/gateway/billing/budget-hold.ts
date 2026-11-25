import "server-only";
import { randomUUID } from "node:crypto";
import prisma from "@/lib/db/prisma";
import { money } from "@/lib/utils/money";
import type { Prisma } from "@/generated/prisma/client";
import type { BudgetCeiling, HoldOutcome } from "@/types/billing";
import type { BudgetKind } from "@/types/structure";

export const HOLD_TTL_MS = 15 * 60_000;
const HOLD_TRANSACTION = { maxWait: 5_000, timeout: 10_000 } as const;
const LOCK_ORDER: readonly BudgetKind[] = ["key", "user", "member", "team", "org", "project"];
const LOCK = { spend: { increment: 0 } } as const;
const SPEND = { spend: true } as const;

type Tx = Prisma.TransactionClient;

function holderKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

function lockOrder(ceiling: BudgetCeiling): number {
  return LOCK_ORDER.indexOf(ceiling.kind);
}

async function lockedSpend(tx: Tx, kind: BudgetKind, id: string): Promise<number | null> {
  const query = { where: { id }, data: LOCK, select: SPEND };
  let rows: { spend: Prisma.Decimal }[];
  switch (kind) {
    case "key":
      rows = await tx.virtualKey.updateManyAndReturn(query);
      break;
    case "user":
      rows = await tx.user.updateManyAndReturn(query);
      break;
    case "member":
      rows = await tx.member.updateManyAndReturn(query);
      break;
    case "team":
      rows = await tx.team.updateManyAndReturn(query);
      break;
    case "org":
      rows = await tx.organization.updateManyAndReturn(query);
      break;
    case "project":
      rows = await tx.project.updateManyAndReturn(query);
      break;
  }
  return rows[0] ? money(rows[0].spend) : null;
}

export async function reserveBudget(
  input: { ceilings: BudgetCeiling[]; wanted: number; minimum: number; release: string[] },
  now = new Date(),
): Promise<HoldOutcome> {
  const ordered = [...input.ceilings].sort((a, b) => lockOrder(a) - lockOrder(b));
  return prisma.$transaction(async (tx) => {
    if (input.release.length) await tx.budgetHold.deleteMany({ where: { holdId: { in: input.release } } });
    const spends = new Map<string, number>();
    for (const ceiling of ordered) {
      const spend = await lockedSpend(tx, ceiling.kind, ceiling.id);
      if (spend !== null) spends.set(holderKey(ceiling.kind, ceiling.id), spend);
    }
    const live = ordered.filter((ceiling) => spends.has(holderKey(ceiling.kind, ceiling.id)));
    if (!live.length) return { granted: true, holdId: "", amount: input.wanted };
    const held = await tx.budgetHold.groupBy({
      by: ["entityType", "entityId"],
      where: {
        expiresAt: { gt: now },
        OR: live.map((ceiling) => ({ entityType: ceiling.kind, entityId: ceiling.id })),
      },
      _sum: { amount: true },
    });
    const heldBy = new Map(held.map((row) => [holderKey(row.entityType, row.entityId), money(row._sum.amount)]));
    let available = Number.POSITIVE_INFINITY;
    let binding: BudgetKind | null = null;
    for (const ceiling of live) {
      const key = holderKey(ceiling.kind, ceiling.id);
      const left = ceiling.limit - spends.get(key)! - (heldBy.get(key) ?? 0);
      if (left < available) {
        available = left;
        binding = ceiling.kind;
      }
    }
    const amount = Math.min(input.wanted, available);
    if (!(available > 0) || amount < input.minimum) {
      return { granted: false, available: Math.max(0, available), binding };
    }
    const holdId = randomUUID();
    const expiresAt = new Date(now.getTime() + HOLD_TTL_MS);
    await tx.budgetHold.createMany({
      data: live.map((ceiling) => ({ holdId, entityType: ceiling.kind, entityId: ceiling.id, amount, expiresAt })),
    });
    return { granted: true, holdId, amount };
  }, HOLD_TRANSACTION);
}

export function settleHolds(holdIds: string[]): Prisma.PrismaPromise<Prisma.BatchPayload> {
  return prisma.budgetHold.deleteMany({ where: { holdId: { in: holdIds } } });
}

export async function releaseHolds(holdIds: string[]): Promise<void> {
  if (holdIds.length) await settleHolds(holdIds);
}

export async function sweepExpiredHolds(now: Date): Promise<number> {
  const { count } = await prisma.budgetHold.deleteMany({ where: { expiresAt: { lt: now } } });
  return count;
}
