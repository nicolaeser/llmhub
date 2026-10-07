import "server-only";

import prisma from "@/lib/db/prisma";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { redactPii } from "@/lib/gateway/pii";
import { parseLogFilters, requestLogWhere } from "@/lib/gateway/request-log-query";
import { groupRequestHealth } from "@/lib/gateway/usage-stats";
import { usageSlices, usageWindowStart } from "@/lib/gateway/usage-totals";
import { money } from "@/lib/utils/money";
import type { Prisma } from "@/generated/prisma/client";
import type {
  AssistantContext,
  LogSearchQuery,
  UsageBreakdownGroup,
  UsageBreakdownQuery,
} from "@/types/assistant";
import type { SliceRow, UsageSlice } from "@/types/gateway";
import type { SpendScope } from "@/types/structure";

const HOUR_MS = 3_600_000;
const DEFAULT_LOG_HOURS = 24;
const MAX_LOG_HOURS = 24 * 31;
const DEFAULT_LOG_ROWS = 15;
const MAX_LOG_ROWS = 50;
const MAX_LOG_GROUPS = 10;
const MAX_ERROR_SAMPLES = 5;
const MAX_ERROR_CHARS = 300;
const DEFAULT_USAGE_DAYS = 7;
const MAX_USAGE_DAYS = 366;
const DEFAULT_USAGE_ROWS = 10;
const MAX_USAGE_ROWS = 25;
const UNASSIGNED = "unassigned";

export const USAGE_GROUP_FIELDS = {
  model: "model",
  org: "orgId",
  team: "teamId",
  project: "projectId",
  member: "memberId",
  key: "keyId",
  user: "userId",
} as const satisfies Record<UsageBreakdownGroup, keyof UsageSlice>;

function boundedInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function rounded(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function isUsageGroup(value: unknown): value is UsageBreakdownGroup {
  return typeof value === "string" && Object.hasOwn(USAGE_GROUP_FIELDS, value);
}

function spendScopeOf(ctx: AssistantContext): SpendScope {
  return {
    ...(ctx.orgId ? { orgId: ctx.orgId } : {}),
    ...(hasPerm(ctx.permissions, PERMISSIONS.SPEND_READ_ALL) ? {} : { userId: ctx.userId }),
  };
}

export function parseLogSearch(
  args: Record<string, unknown>,
  now = new Date(),
): LogSearchQuery {
  const hours = boundedInt(args.hours, 1, MAX_LOG_HOURS, DEFAULT_LOG_HOURS);
  const status = boundedInt(args.status, 0, 999, 0);
  const validStatus = status >= 100 && status <= 599;
  return {
    filters: parseLogFilters({
      model: args.model,
      endpoint: args.endpoint,
      status: validStatus ? String(status) : "",
      from: text(args.from, 32) || new Date(now.getTime() - hours * HOUR_MS).toISOString(),
      to: text(args.to, 32),
    }),
    errorsOnly: args.errorsOnly === true,
    limit: boundedInt(args.limit, 1, MAX_LOG_ROWS, DEFAULT_LOG_ROWS),
  };
}

export function parseUsageBreakdown(args: Record<string, unknown>): UsageBreakdownQuery {
  return {
    groupBy: isUsageGroup(args.groupBy) ? args.groupBy : "model",
    days: boundedInt(args.days, 1, MAX_USAGE_DAYS, DEFAULT_USAGE_DAYS),
    model: text(args.model, 200),
    sort: args.sort === "requests" || args.sort === "errors" ? args.sort : "spend",
    limit: boundedInt(args.limit, 1, MAX_USAGE_ROWS, DEFAULT_USAGE_ROWS),
  };
}

export function sortUsageRows(rows: SliceRow[], sort: UsageBreakdownQuery["sort"]): SliceRow[] {
  const metric = (row: SliceRow) =>
    sort === "requests" ? (row.requests ?? 0) : sort === "errors" ? (row.errors ?? 0) : row.spend;
  return [...rows].sort((a, b) => metric(b) - metric(a) || (b.requests ?? 0) - (a.requests ?? 0));
}

export function errorSamples(
  rows: { error: string }[],
): { message: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.error) continue;
    const message = redactPii(row.error, ["SECRET", "JWT"]).slice(0, MAX_ERROR_CHARS);
    counts.set(message, (counts.get(message) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([message, count]) => ({ message, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_ERROR_SAMPLES);
}

async function keyLabels(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const keys = await prisma.virtualKey.findMany({
    where: { id: { in: ids } },
    select: { id: true, keyAlias: true, prefix: true },
  });
  return new Map(keys.map((key) => [key.id, key.keyAlias || key.prefix]));
}

async function userLabels(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, username: true },
  });
  return new Map(users.map((user) => [user.id, user.username]));
}

async function aliasLabels(
  rows: Promise<{ id: string; alias: string }[]>,
): Promise<Map<string, string>> {
  return new Map((await rows).map((row) => [row.id, row.alias]));
}

async function groupLabels(
  group: UsageBreakdownGroup,
  names: string[],
): Promise<Map<string, string>> {
  const ids = names.filter((name) => name && name !== UNASSIGNED);
  if (!ids.length) return new Map();
  const where = { id: { in: ids } };
  const select = { id: true, alias: true } as const;
  switch (group) {
    case "team":
      return aliasLabels(prisma.team.findMany({ where, select }));
    case "org":
      return aliasLabels(prisma.organization.findMany({ where, select }));
    case "project":
      return aliasLabels(prisma.project.findMany({ where, select }));
    case "member":
      return new Map(
        (await prisma.member.findMany({ where, select: { id: true, name: true } })).map((row) => [row.id, row.name]),
      );
    case "key":
      return keyLabels(ids);
    case "user":
      return userLabels(ids);
    default:
      return new Map();
  }
}

export async function searchLogs(query: LogSearchQuery, ctx: AssistantContext) {
  const scope = spendScopeOf(ctx);
  const owner = scope.userId ?? null;
  const where: Prisma.RequestLogWhereInput = {
    ...requestLogWhere(query.filters, scope),
    ...(query.errorsOnly ? { outcome: { not: "ok" } } : {}),
  };
  const [total, groups, rows] = await Promise.all([
    prisma.requestLog.count({ where }),
    prisma.requestLog.groupBy({
      by: ["status", "outcome", "provider", "upstreamModel"],
      where,
      _count: { _all: true },
    }),
    prisma.requestLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: query.limit,
      select: {
        id: true,
        createdAt: true,
        model: true,
        endpoint: true,
        status: true,
        outcome: true,
        latencyMs: true,
        keyId: true,
        userId: true,
        provider: true,
        upstreamModel: true,
        promptTokens: true,
        completionTokens: true,
        cost: true,
        error: true,
      },
    }),
  ]);
  const [keys, users] = await Promise.all([
    keyLabels([...new Set(rows.map((row) => row.keyId).filter(Boolean))]),
    owner
      ? Promise.resolve(new Map<string, string>())
      : userLabels([...new Set(rows.map((row) => row.userId).filter(Boolean))]),
  ]);
  return {
    window: { from: query.filters.from, to: query.filters.to || "now" },
    total,
    byStatus: groups
      .map((group) => ({
        status: group.status,
        outcome: group.outcome,
        provider: group.provider,
        upstreamModel: group.upstreamModel,
        count: group._count._all,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_LOG_GROUPS),
    errors: errorSamples(rows),
    requests: rows.map((row) => ({
      id: row.id,
      at: row.createdAt.toISOString(),
      model: row.model,
      endpoint: row.endpoint,
      status: row.status,
      outcome: row.outcome,
      latencyMs: row.latencyMs,
      key: keys.get(row.keyId) ?? "",
      ...(owner ? {} : { user: users.get(row.userId) ?? "" }),
      provider: row.provider,
      upstreamModel: row.upstreamModel,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      cost: rounded(money(row.cost)),
    })),
  };
}

export async function usageBreakdown(query: UsageBreakdownQuery, ctx: AssistantContext) {
  const since = usageWindowStart(query.days);
  const slices = await usageSlices({
    ...(query.model ? { model: query.model } : {}),
    ...spendScopeOf(ctx),
    day: { gte: since },
  });
  const grouped = sortUsageRows(
    groupRequestHealth(slices, USAGE_GROUP_FIELDS[query.groupBy]),
    query.sort,
  );
  const top = grouped.slice(0, query.limit);
  const labels = await groupLabels(
    query.groupBy,
    top.map((row) => row.name),
  );
  const totals = grouped.reduce(
    (sum, row) => ({
      spend: sum.spend + row.spend,
      requests: sum.requests + (row.requests ?? 0),
      errors: sum.errors + (row.errors ?? 0),
      rateLimited: sum.rateLimited + (row.rate429 ?? 0),
    }),
    { spend: 0, requests: 0, errors: 0, rateLimited: 0 },
  );
  return {
    window: { days: query.days, from: since.toISOString().slice(0, 10) },
    groupBy: query.groupBy,
    sort: query.sort,
    groups: grouped.length,
    totals: { ...totals, spend: rounded(totals.spend) },
    rows: top.map((row) => {
      const requests = row.requests ?? 0;
      const errors = row.errors ?? 0;
      return {
        name: labels.get(row.name) ?? row.name,
        spend: rounded(row.spend),
        requests,
        errors,
        errorRate: requests ? rounded(errors / requests, 4) : 0,
        rateLimited: row.rate429 ?? 0,
        avgLatencyMs: Math.round(row.latency ?? 0),
        promptTokens: row.prompt,
        completionTokens: row.completion,
      };
    }),
  };
}
