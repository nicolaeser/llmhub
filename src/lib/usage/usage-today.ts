import "server-only";
import prisma from "@/lib/db/prisma";
import { requirePermission } from "@/lib/auth/guards";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { spendScope, spendScopeKey } from "@/lib/auth/scope";
import { money } from "@/lib/utils/money";
import type { LiveFeed, UsageToday } from "@/types/live";
import type { SpendScope } from "@/types/structure";

function utcDay(now: number): Date {
  const date = new Date(now);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export async function usageToday(scope: SpendScope, now = Date.now()): Promise<UsageToday> {
  const day = utcDay(now);
  const totals = await prisma.usageDaily.aggregate({
    where: { day, ...scope },
    _sum: { requests: true, errors: true, cost: true, promptTokens: true, completionTokens: true },
  });
  const sum = totals._sum;
  return {
    at: now,
    day: day.toISOString().slice(0, 10),
    spend: money(sum.cost),
    requests: sum.requests ?? 0,
    errors: sum.errors ?? 0,
    tokens: Number(sum.promptTokens ?? 0) + Number(sum.completionTokens ?? 0),
  };
}

export async function loadUsageToday(): Promise<UsageToday> {
  const session = await requirePermission(PERMISSIONS.SPEND_READ);
  return usageToday(spendScope(session));
}

function sameTotals(a: UsageToday, b: UsageToday): boolean {
  return a.day === b.day && a.requests === b.requests && a.errors === b.errors && a.spend === b.spend && a.tokens === b.tokens;
}

export const USAGE_FEED: LiveFeed<UsageToday> = {
  topic: "usage",
  permission: PERMISSIONS.SPEND_READ,
  pollMs: 10_000,
  minGapMs: 5_000,
  scopeKey: spendScopeKey,
  load: (scope) => usageToday(scope),
  full: (state) => state,
  change: (previous, next) => (sameTotals(previous, next) ? null : next),
};
