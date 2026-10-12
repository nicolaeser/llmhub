import "server-only";

import { requirePermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { spendScope } from "@/lib/auth/scope";
import {
  chargebackRows,
  groupCache,
  groupRequestHealth,
  groupSpend,
  summarizeUsage,
  usageDays,
} from "@/lib/usage/usage-stats";
import { p95Latency, usageNames, usageSlices } from "@/lib/usage/usage-totals";
import type { UsageSlice } from "@/types/gateway";

export async function loadUsage(
  input:
    | number
    | {
        days?: number;
        model?: string;
        teamId?: string;
        orgId?: string;
        projectId?: string;
        memberId?: string;
        keyId?: string;
        userId?: string;
      } = 14,
) {
  const session = await requirePermission(PERMISSIONS.SPEND_READ);
  const query = typeof input === "number" ? { days: input } : input;
  const text = (value: string | undefined) => (value ?? "").trim();
  const days = Math.min(366, Math.max(1, Math.trunc(query.days ?? 14) || 14));
  const model = text(query.model);
  const teamId = text(query.teamId);
  const orgId = text(query.orgId);
  const projectId = text(query.projectId);
  const memberId = text(query.memberId);
  const keyId = text(query.keyId);
  const userId = text(query.userId);
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const since = new Date(today - (days - 1) * 86400000);
  const filters = {
    ...(model ? { model } : {}),
    ...(teamId ? { teamId } : {}),
    ...(orgId ? { orgId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(memberId ? { memberId } : {}),
    ...(keyId ? { keyId } : {}),
    ...(userId ? { userId } : {}),
    ...spendScope(session),
  };
  const priced = hasPerm(session.permissions, PERMISSIONS.PRICING_READ);
  const [rows, p95] = await Promise.all([
    usageSlices({ ...filters, day: { gte: since } }, { purchase: priced }),
    p95Latency({ ...filters, createdAt: { gte: since } }),
  ]);
  const summary = summarizeUsage(rows, usageDays(since, days));
  const distinct = (pick: (row: UsageSlice) => string) =>
    [...new Set(rows.map(pick).filter(Boolean))].sort();
  return {
    days,
    model,
    teamId,
    orgId,
    projectId,
    memberId,
    keyId,
    userId,
    names: await usageNames(rows),
    models: distinct((row) => row.model),
    teams: distinct((row) => row.teamId),
    orgs: distinct((row) => row.orgId),
    projects: distinct((row) => row.projectId),
    members: distinct((row) => row.memberId),
    keys: distinct((row) => row.keyId),
    users: distinct((row) => row.userId),
    spend: summary.spend,
    purchase: priced ? rows.reduce((sum, row) => sum + (row.purchaseCost ?? 0), 0) : null,
    tokens: summary.tokens,
    count: summary.count,
    errors: summary.errors,
    rate429: summary.rate429,
    latency: summary.latency,
    p95Latency: p95,
    cacheRead: summary.cacheRead,
    cacheWrite: summary.cacheWrite,
    cacheSavings: summary.cacheSavings,
    cacheHitRate: summary.cacheHitRate,
    daily: summary.daily,
    byModel: groupSpend(rows, "model").slice(0, 12),
    byTeam: groupSpend(rows, "teamId").slice(0, 12),
    byOrg: groupSpend(rows, "orgId").slice(0, 12),
    byProject: groupSpend(rows, "projectId").slice(0, 12),
    byMember: groupSpend(rows, "memberId").slice(0, 12),
    byKey: groupSpend(rows, "keyId").slice(0, 12),
    byUser: groupSpend(rows, "userId").slice(0, 12),
    healthByModel: groupRequestHealth(rows, "model").slice(0, 12),
    healthByTeam: groupRequestHealth(rows, "teamId").slice(0, 12),
    cacheByProject: groupCache(rows, "projectId").slice(0, 12),
    chargeback: chargebackRows(rows),
  };
}
