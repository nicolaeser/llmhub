import "server-only";
import prisma from "@/lib/db/prisma";
import { percentileIndex } from "@/lib/gateway/usage-stats";
import { money } from "@/lib/utils/money";
import type { Prisma } from "@/generated/prisma/client";
import type { ResponseCacheStats } from "@/types/cache";
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
    cacheReadTokens: Number(row.cacheReadTokens),
    cacheWriteTokens: Number(row.cacheWriteTokens),
    cost: money(row.cost),
    cacheSavings: money(row.cacheSavings),
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

export async function usageNames(rows: UsageSlice[]): Promise<Record<string, string>> {
  const ids = (pick: (row: UsageSlice) => string) => [...new Set(rows.map(pick).filter(Boolean))];
  const [orgs, teams, projects, members, keys, users] = await Promise.all([
    prisma.organization.findMany({ where: { id: { in: ids((row) => row.orgId) } }, select: { id: true, alias: true } }),
    prisma.team.findMany({ where: { id: { in: ids((row) => row.teamId) } }, select: { id: true, alias: true } }),
    prisma.project.findMany({ where: { id: { in: ids((row) => row.projectId) } }, select: { id: true, alias: true } }),
    prisma.member.findMany({ where: { id: { in: ids((row) => row.memberId) } }, select: { id: true, name: true } }),
    prisma.virtualKey.findMany({
      where: { id: { in: ids((row) => row.keyId) } },
      select: { id: true, keyAlias: true, prefix: true },
    }),
    prisma.user.findMany({ where: { id: { in: ids((row) => row.userId) } }, select: { id: true, username: true } }),
  ]);
  return Object.fromEntries([
    ...orgs.map((row) => [row.id, row.alias]),
    ...teams.map((row) => [row.id, row.alias]),
    ...projects.map((row) => [row.id, row.alias]),
    ...members.map((row) => [row.id, row.name]),
    ...keys.map((row) => [row.id, row.keyAlias || row.prefix]),
    ...users.map((row) => [row.id, row.username]),
  ]);
}

export async function p95Latency(where: Prisma.RequestLogWhereInput): Promise<number> {
  const logged = await prisma.requestLog.count({ where });
  if (!logged) return 0;
  const row = await prisma.requestLog.findFirst({
    where,
    orderBy: { latencyMs: "asc" },
    skip: percentileIndex(logged, 95),
    select: { latencyMs: true },
  });
  return row?.latencyMs ?? 0;
}

export function responseCacheStats(
  days: number,
  sums: { hits: number; semanticHits: number; misses: number; savedTokens: number; savedCost: number; lookupCost: number },
): ResponseCacheStats {
  const lookups = sums.hits + sums.misses;
  return {
    days,
    ...sums,
    hitRate: lookups ? sums.hits / lookups : 0,
    netSaved: sums.savedCost - sums.lookupCost,
  };
}

export async function responseCacheTotals(days: number): Promise<ResponseCacheStats> {
  const totals = await prisma.usageDaily.aggregate({
    where: { day: { gte: usageWindowStart(days) } },
    _sum: {
      responseCacheHits: true,
      responseCacheSemanticHits: true,
      responseCacheMisses: true,
      responseCacheSavedTokens: true,
      responseCacheSavedCost: true,
      responseCacheLookupCost: true,
    },
  });
  return responseCacheStats(days, {
    hits: totals._sum.responseCacheHits ?? 0,
    semanticHits: totals._sum.responseCacheSemanticHits ?? 0,
    misses: totals._sum.responseCacheMisses ?? 0,
    savedTokens: Number(totals._sum.responseCacheSavedTokens ?? 0),
    savedCost: money(totals._sum.responseCacheSavedCost),
    lookupCost: money(totals._sum.responseCacheLookupCost),
  });
}
