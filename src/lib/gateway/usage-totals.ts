import "server-only";
import prisma from "@/lib/db/prisma";
import { money } from "@/lib/utils/money";
import type { Prisma } from "@/generated/prisma/client";
import type { UsageSlice } from "@/types/gateway";
import type { MarginTotals } from "@/types/pricing";
import type { SpendScope } from "@/types/structure";

export function usageWindowStart(days: number, now = new Date()): Date {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(today - (days - 1) * 86400000);
}

export async function usageSlices(
  where: Prisma.UsageDailyWhereInput,
  options: { purchase?: boolean } = {},
): Promise<UsageSlice[]> {
  const rows = await prisma.usageDaily.findMany({ where });
  return rows.map((row) => ({
    day: row.day.toISOString().slice(0, 10),
    keyId: row.keyId,
    teamId: row.teamId,
    orgId: row.orgId,
    projectId: row.projectId,
    memberId: row.memberId,
    userId: row.userId,
    model: row.model,
    requests: row.requests,
    errors: row.errors,
    rateLimited: row.rateLimited,
    latencyMs: Number(row.latencyMs),
    promptTokens: Number(row.promptTokens),
    completionTokens: Number(row.completionTokens),
    cost: money(row.cost),
    ...(options.purchase ? { purchaseCost: money(row.purchaseCost) } : {}),
  }));
}

export async function marginTotals(days: number): Promise<MarginTotals> {
  const totals = await prisma.usageDaily.aggregate({
    where: { day: { gte: usageWindowStart(days) } },
    _sum: { cost: true, purchaseCost: true },
  });
  return { purchase: money(totals._sum.purchaseCost), sale: money(totals._sum.cost) };
}

export async function usageTotals(days: number, scope: SpendScope = {}) {
  const totals = await prisma.usageDaily.aggregate({
    where: { day: { gte: usageWindowStart(days) }, ...scope },
    _sum: { cost: true, requests: true, errors: true },
  });
  return {
    spend7d: money(totals._sum.cost),
    requests7d: totals._sum.requests ?? 0,
    errors7d: totals._sum.errors ?? 0,
  };
}
