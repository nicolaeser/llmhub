import "server-only";
import prisma from "@/lib/db/prisma";
import { money } from "@/lib/utils/money";
import type { SpendScope } from "@/types/structure";

export async function usageTotals(days: number, scope: SpendScope = {}) {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const totals = await prisma.usageDaily.aggregate({
    where: { day: { gte: new Date(today - (days - 1) * 86400000) }, ...scope },
    _sum: { cost: true, requests: true, errors: true },
  });
  return {
    spend7d: money(totals._sum.cost),
    requests7d: totals._sum.requests ?? 0,
    errors7d: totals._sum.errors ?? 0,
  };
}
