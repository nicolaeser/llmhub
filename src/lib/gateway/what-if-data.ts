import "server-only";
import prisma from "@/lib/db/prisma";
import { markupRuleOf } from "@/lib/gateway/markup-policy";
import { priceWindowQuery, priceWindowRates } from "@/lib/gateway/price-schedule";
import { catalogPricesOf } from "@/lib/gateway/provider-prices";
import { usageWindowStart } from "@/lib/gateway/usage-totals";
import {
  addMinutes,
  expectedRates,
  isScheduled,
  markedUpCost,
  meanRates,
  ratesPriced,
} from "@/lib/gateway/what-if";
import { money } from "@/lib/utils/money";
import type { Prisma } from "@/generated/prisma/client";
import type { CostRates } from "@/types/gateway";
import type { MarkupTenancy } from "@/types/pricing";
import type { SpendScope } from "@/types/structure";
import type {
  MinuteTokens,
  TargetPrice,
  TenantMinutes,
  TenantTraffic,
  TrafficTotals,
  WhatIfSource,
  WhatIfTargetInput,
  WhatIfView,
} from "@/types/what-if";

export const WHAT_IF_DAYS = 30;

const SCAN_BATCH = 5000;

const AUTO_ALIAS = "auto";

function flatPrice(rates: CostRates, floor: CostRates | null = null): TargetPrice {
  return { schedule: { price: rates, time_zone: "UTC", windows: [] }, floor };
}

function groupPrice(group: {
  strategy: string;
  billingMode: string;
  priceInput: Prisma.Decimal;
  priceOutput: Prisma.Decimal;
  priceTimeZone: string;
  priceWindows: { startMinute: number; endMinute: number; priceInput: Prisma.Decimal; priceOutput: Prisma.Decimal }[];
  deployments: { costInput: Prisma.Decimal; costOutput: Prisma.Decimal; weight: number }[];
}): TargetPrice | null {
  if (group.billingMode === "custom") {
    return {
      schedule: {
        price: { cost_input_per_1k: money(group.priceInput), cost_output_per_1k: money(group.priceOutput) },
        time_zone: group.priceTimeZone,
        windows: group.priceWindows.map(priceWindowRates),
      },
      floor: null,
    };
  }
  const deployments = group.deployments.map((dep) => ({
    cost_input_per_1k: money(dep.costInput),
    cost_output_per_1k: money(dep.costOutput),
    weight: dep.weight,
  }));
  const routed = expectedRates(group.strategy, deployments);
  if (!routed) return null;
  return flatPrice(routed, group.billingMode === "average" ? meanRates(deployments) : null);
}

async function whatIfTargets(): Promise<WhatIfTargetInput[]> {
  const [groups, entries, providers] = await Promise.all([
    prisma.modelGroup.findMany({
      orderBy: { alias: "asc" },
      select: {
        alias: true,
        enabled: true,
        vendor: true,
        displayName: true,
        strategy: true,
        billingMode: true,
        priceInput: true,
        priceOutput: true,
        priceTimeZone: true,
        priceWindows: priceWindowQuery,
        deployments: { select: { costInput: true, costOutput: true, weight: true } },
      },
    }),
    prisma.catalogEntry.findMany({
      where: { alias: { not: "" }, disabled: false },
      orderBy: [{ alias: "asc" }, { providerId: "asc" }, { upstreamId: "asc" }],
      select: { providerId: true, upstreamId: true, alias: true, name: true, vendor: true },
    }),
    prisma.providerConnection.findMany({ select: { id: true, discovered: true } }),
  ]);
  const targets: WhatIfTargetInput[] = [];
  for (const group of groups) {
    const price = group.alias === AUTO_ALIAS ? null : groupPrice(group);
    if (!price) continue;
    targets.push({
      alias: group.alias,
      vendor: group.vendor,
      displayName: group.displayName,
      state: group.enabled ? "active" : "disabled",
      price,
    });
  }
  const grouped = new Set(groups.map((group) => group.alias));
  const prices = new Map(
    providers.map((provider) => [
      provider.id,
      new Map(catalogPricesOf(provider.discovered).map((row) => [row.id, row])),
    ]),
  );
  const missing = new Map<string, { vendor: string; displayName: string; rates: CostRates[] }>();
  for (const entry of entries) {
    if (grouped.has(entry.alias) || entry.alias === AUTO_ALIAS) continue;
    const listed = prices.get(entry.providerId)?.get(entry.upstreamId);
    const rates = listed ? { cost_input_per_1k: listed.costInput, cost_output_per_1k: listed.costOutput } : null;
    const current = missing.get(entry.alias) ?? { vendor: "", displayName: "", rates: [] };
    current.vendor ||= entry.vendor;
    current.displayName ||= entry.name;
    if (rates && ratesPriced(rates)) current.rates.push(rates);
    missing.set(entry.alias, current);
  }
  for (const [alias, entry] of missing) {
    const rates = meanRates(entry.rates);
    if (!rates) continue;
    targets.push({ alias, vendor: entry.vendor, displayName: entry.displayName, state: "missing", price: flatPrice(rates) });
  }
  return targets;
}

function tenancyKey(row: MarkupTenancy): string {
  return `${row.orgId}/${row.teamId}/${row.projectId}`;
}

async function minuteTraffic(where: Prisma.RequestLogWhereInput): Promise<TenantMinutes[]> {
  const tenants = new Map<string, MarkupTenancy & { buckets: Map<number, MinuteTokens> }>();
  let cursor: string | undefined;
  let batch: (MarkupTenancy & { id: string; createdAt: Date; promptTokens: number; completionTokens: number })[];
  do {
    batch = await prisma.requestLog.findMany({
      where,
      orderBy: { id: "asc" },
      take: SCAN_BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        createdAt: true,
        promptTokens: true,
        completionTokens: true,
        orgId: true,
        teamId: true,
        projectId: true,
      },
    });
    for (const row of batch) {
      const key = tenancyKey(row);
      const tenant = tenants.get(key) ?? {
        orgId: row.orgId,
        teamId: row.teamId,
        projectId: row.projectId,
        buckets: new Map<number, MinuteTokens>(),
      };
      addMinutes(tenant.buckets, [row]);
      tenants.set(key, tenant);
    }
    cursor = batch.at(-1)?.id;
  } while (batch.length === SCAN_BATCH);
  return [...tenants.values()].map(({ buckets, ...tenancy }) => ({ ...tenancy, minutes: [...buckets.values()] }));
}

function tenantTraffic(rows: (MarkupTenancy & { prompt: number; completion: number })[]): TenantTraffic[] {
  const tenants = new Map<string, TenantTraffic>();
  for (const row of rows) {
    const key = tenancyKey(row);
    const tenant = tenants.get(key) ?? {
      orgId: row.orgId,
      teamId: row.teamId,
      projectId: row.projectId,
      prompt: 0,
      completion: 0,
    };
    tenant.prompt += row.prompt;
    tenant.completion += row.completion;
    tenants.set(key, tenant);
  }
  return [...tenants.values()];
}

function sumTraffic(rows: TrafficTotals[]): TrafficTotals {
  return rows.reduce(
    (sum, row) => ({
      requests: sum.requests + row.requests,
      prompt: sum.prompt + row.prompt,
      completion: sum.completion + row.completion,
      cost: sum.cost + row.cost,
    }),
    { requests: 0, prompt: 0, completion: 0, cost: 0 },
  );
}

export async function loadWhatIf(scope: SpendScope, model: string, now = new Date()): Promise<WhatIfView> {
  const since = usageWindowStart(WHAT_IF_DAYS, now);
  const where: Prisma.RequestLogWhereInput = {
    ...scope,
    createdAt: { gte: since, lt: now },
    OR: [{ promptTokens: { gt: 0 } }, { completionTokens: { gt: 0 } }],
  };
  const [grouped, targets, markups] = await Promise.all([
    prisma.requestLog.groupBy({
      by: ["model", "orgId", "teamId", "projectId"],
      where,
      _count: { _all: true },
      _sum: { promptTokens: true, completionTokens: true, cost: true },
      _min: { createdAt: true },
    }),
    whatIfTargets(),
    prisma.priceMarkup.findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true, orgId: true, teamId: true, projectId: true, model: true, percent: true },
    }),
  ]);
  const rows = grouped.map((row) => ({
    model: row.model,
    orgId: row.orgId,
    teamId: row.teamId,
    projectId: row.projectId,
    requests: row._count._all,
    prompt: row._sum.promptTokens ?? 0,
    completion: row._sum.completionTokens ?? 0,
    cost: money(row._sum.cost),
    firstAt: row._min.createdAt,
  }));
  const byModel = new Map<string, WhatIfSource>();
  for (const row of rows) {
    const source = byModel.get(row.model) ?? { model: row.model, requests: 0, prompt: 0, completion: 0, cost: 0 };
    source.requests += row.requests;
    source.prompt += row.prompt;
    source.completion += row.completion;
    source.cost += row.cost;
    byModel.set(row.model, source);
  }
  const sources = [...byModel.values()].sort(
    (a, b) => b.cost - a.cost || b.requests - a.requests || a.model.localeCompare(b.model),
  );
  const selected = byModel.has(model) ? model : "";
  const picked = selected ? sources.filter((source) => source.model === selected) : sources;
  const pickedRows = selected ? rows.filter((row) => row.model === selected) : rows;
  const traffic = sumTraffic(picked);
  const tenants = tenantTraffic(pickedRows);
  const rules = markups.map(markupRuleOf);
  const minutes =
    traffic.requests && targets.some((target) => isScheduled(target.price))
      ? await minuteTraffic(selected ? { ...where, model: selected } : where)
      : [];
  const firstAt = pickedRows.reduce<Date | null>(
    (first, row) => (row.firstAt && (!first || row.firstAt < first) ? row.firstAt : first),
    null,
  );
  return {
    days: WHAT_IF_DAYS,
    since: since.toISOString(),
    firstAt: firstAt?.toISOString() ?? null,
    model: selected,
    sources,
    traffic,
    targets: targets
      .map((target) => ({
        alias: target.alias,
        vendor: target.vendor,
        displayName: target.displayName,
        state: target.state,
        scheduled: isScheduled(target.price),
        cost: markedUpCost(target.price, target.alias, rules, tenants, minutes),
      }))
      .sort((a, b) => a.cost - b.cost || a.alias.localeCompare(b.alias)),
  };
}
