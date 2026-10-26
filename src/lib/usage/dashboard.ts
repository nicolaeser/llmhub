import "server-only";

import { requireActor, requirePermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { companyOf, spendScope } from "@/lib/auth/scope";
import { labelKey, labelValue, storedLabel } from "@/lib/usage/labels";
import {
  chargebackRows,
  groupByLabel,
  groupCache,
  groupRequestHealth,
  groupSpend,
  labelBreakdown,
  summarizeUsage,
  usageDays,
} from "@/lib/usage/usage-stats";
import {
  p95Latency,
  usageLabelKeys,
  usageLabelSlices,
  usageLabelValues,
  usageNames,
  usageSlices,
} from "@/lib/usage/usage-totals";
import type { UsageSlice, UsageTab } from "@/types/usage";

export async function loadUsageTabs(): Promise<UsageTab[]> {
  const session = await requireActor();
  const tabs: UsageTab[] = [];
  if (hasPerm(session.permissions, PERMISSIONS.SPEND_READ)) tabs.push("overview");
  if (hasPerm(session.permissions, PERMISSIONS.PRICING_READ) && !companyOf(session)) tabs.push("markups");
  return tabs;
}

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
        labelKey?: string;
        labelValue?: string;
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
  const groupLabel = labelKey(query.labelKey) ?? "";
  const filterLabel = groupLabel ? (labelValue(query.labelValue) ?? "") : "";
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const since = new Date(today - (days - 1) * 86400000);
  const requested = {
    ...(model ? { model } : {}),
    ...(teamId ? { teamId } : {}),
    ...(orgId ? { orgId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(memberId ? { memberId } : {}),
    ...(keyId ? { keyId } : {}),
    ...(userId ? { userId } : {}),
  };
  const filters = { AND: [requested, spendScope(session)] };
  const priced = hasPerm(session.permissions, PERMISSIONS.PRICING_READ);
  const day = { gte: since };
  const [daily, labeled, p95, labelKeys, labelValues] = await Promise.all([
    filterLabel ? [] : usageSlices({ ...filters, day }, { purchase: priced }),
    groupLabel
      ? usageLabelSlices(
          { ...filters, day, label: groupLabel, ...(filterLabel ? { value: filterLabel } : {}) },
          { purchase: priced },
        )
      : [],
    p95Latency({
      ...filters,
      createdAt: { gte: since },
      ...(filterLabel ? { labels: { has: storedLabel({ key: groupLabel, value: filterLabel }) } } : {}),
    }),
    usageLabelKeys({ ...filters, day }),
    groupLabel ? usageLabelValues({ ...filters, day, label: groupLabel }) : [],
  ]);
  const rows = filterLabel ? labeled : daily;
  const labelRows = filterLabel ? labeled : groupLabel ? labelBreakdown(daily, labeled) : [];
  const summary = summarizeUsage(rows, usageDays(since, days));
  const distinct = (pick: (row: UsageSlice) => string) =>
    [...new Set(rows.map(pick).filter(Boolean))].sort();
  return {
    companyView: Boolean(companyOf(session)),
    days,
    model,
    teamId,
    orgId,
    projectId,
    memberId,
    keyId,
    userId,
    labelKey: groupLabel,
    labelValue: filterLabel,
    labelKeys,
    labelValues,
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
    byLabel: groupByLabel(labelRows),
    chargeback: chargebackRows(groupLabel ? labelRows : rows),
  };
}
