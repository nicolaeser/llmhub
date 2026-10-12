import "server-only";
import prisma from "@/lib/db/prisma";
import { PROVIDER_CATALOG } from "@/lib/gateway/catalog";
import {
  nextLatencyEwma,
  pickCostLowest,
  pickLatencyEwma,
  pickLeastInflight,
  pickPriority,
  pickWeighted,
} from "@/lib/gateway/router";
import { asRecord, asStringArray, ERR_NO_HEALTHY, ERR_UNKNOWN_GROUP } from "@/lib/gateway/core";
import { modelAlias } from "@/lib/gateway/model-alias";
import { routePermitted } from "@/lib/gateway/model-policy";
import { priceWindowQuery, priceWindowRates } from "@/lib/gateway/price-schedule";
import { costRejection } from "@/lib/gateway/cost-cap";
import { coolingDown, recordFailure, recordSuccess } from "@/lib/gateway/provider-health";
import type { CostFilter, DbDeployment, Group, ResolvedDeployment, Deployment } from "@/types/gateway";
import type { DeploymentRule, RoutePolicy } from "@/types/model-templates";
import { money } from "@/lib/utils/money";

const inflight = new Map<string, number>();
const latencyEwma = new Map<string, number>();

function mapDeployment(row: DbDeployment): ResolvedDeployment {
  return {
    id: row.id,
    kind: row.kind,
    base_url: row.baseUrl || row.provider?.baseUrl || "",
    model: row.model,
    weight: row.weight,
    cost_input_per_1k: money(row.costInput),
    cost_output_per_1k: money(row.costOutput),
    provider_id: row.providerId ?? "",
    provider: row.provider,
  };
}

const providerSelect = {
  select: {
    id: true,
    kind: true,
    baseUrl: true,
    apiKey: true,
    zdr: true,
    retentionDays: true,
    region: true,
    noTraining: true,
  },
} as const;

function routeOf(dep: ResolvedDeployment): RoutePolicy {
  const provider = dep.provider;
  if (!provider) return null;
  return {
    id: provider.id,
    zdr: provider.zdr,
    retentionDays: provider.retentionDays,
    region: provider.region,
    noTraining: provider.noTraining,
  };
}

export function permittedDeployments(
  items: ResolvedDeployment[],
  rules: DeploymentRule[] | undefined,
): ResolvedDeployment[] {
  return rules ? items.filter((dep) => routePermitted(rules, routeOf(dep))) : items;
}

export async function loadGroup(requested: string): Promise<Group> {
  const alias = modelAlias(requested);
  if (alias === "auto") {
    const rows = await prisma.deployment.findMany({
      where: { group: { enabled: true } },
      include: { provider: providerSelect },
    });
    const mapped = rows.map(mapDeployment);
    return {
      alias: "auto",
      strategy: "cost_lowest",
      billing_mode: "routed",
      price_input_per_1k: 0,
      price_output_per_1k: 0,
      price_time_zone: "UTC",
      price_windows: [],
      overflow_group: "",
      num_retries: 1,
      fallback_groups: [],
      deployments: mapped,
      mapped,
    };
  }

  const group = await prisma.modelGroup.findUnique({
    where: { alias },
    include: {
      deployments: { include: { provider: providerSelect } },
      priceWindows: priceWindowQuery,
    },
  });
  if (!group?.enabled) throw ERR_UNKNOWN_GROUP;
  const mapped = group.deployments.map(mapDeployment);
  return {
    alias: group.alias,
    strategy: group.strategy,
    billing_mode: group.billingMode,
    price_input_per_1k: money(group.priceInput),
    price_output_per_1k: money(group.priceOutput),
    price_time_zone: group.priceTimeZone,
    price_windows: group.priceWindows.map(priceWindowRates),
    overflow_group: group.overflowGroup,
    num_retries: group.numRetries,
    fallback_groups: asStringArray(group.fallbackGroups),
    deployments: mapped,
    mapped,
  };
}

async function healthy(items: ResolvedDeployment[]): Promise<ResolvedDeployment[]> {
  const cooling = await coolingDown(items.map((d) => d.id));
  return items.filter((d) => !cooling.has(d.id));
}

function pick(items: ResolvedDeployment[], strategy: string): ResolvedDeployment {
  switch (strategy) {
    case "weighted_random":
      return pickWeighted(items);
    case "cost_lowest":
      return pickCostLowest(items);
    case "priority":
      return pickPriority(items);
    case "fast":
      return pickLatencyEwma(items, latencyEwma);
    default:
      return pickLeastInflight(items, inflight);
  }
}

function affordable(group: Group, ready: ResolvedDeployment[], cost: CostFilter | undefined): ResolvedDeployment[] {
  if (!cost) return ready;
  const estimates = ready.map((dep) => cost.estimate(dep, group));
  const fitting = ready.filter((_, index) => estimates[index]! <= cost.cap.limit);
  if (!fitting.length) throw costRejection(cost.cap, Math.min(...estimates));
  return fitting;
}

export async function acquireGroup(
  group: Group,
  rules: DeploymentRule[] | undefined,
  serves: (dep: ResolvedDeployment) => boolean = () => true,
  strategy = "",
  cost?: CostFilter,
): Promise<{ dep: ResolvedDeployment; release: () => void; overflow: boolean }> {
  const ready = await healthy(permittedDeployments(group.mapped, rules).filter(serves));
  if (!ready.length) {
    if (group.overflow_group && group.overflow_group !== group.alias) {
      const overflow = await loadGroup(group.overflow_group);
      const acquired = await acquireGroup(overflow, rules, serves, strategy, cost);
      return { ...acquired, overflow: true };
    }
    throw ERR_NO_HEALTHY;
  }
  const dep = pick(affordable(group, ready, cost), strategy || group.strategy);
  inflight.set(dep.id, (inflight.get(dep.id) ?? 0) + 1);
  return {
    dep,
    overflow: false,
    release: () => {
      inflight.set(dep.id, Math.max(0, (inflight.get(dep.id) ?? 1) - 1));
    },
  };
}

export function markFailure(dep: Deployment, retryAt: number | null = null): void {
  recordFailure(dep.id, Date.now(), retryAt);
}

export function markSuccess(dep: Deployment, latencyMs?: number): void {
  recordSuccess(dep.id, latencyMs);
  if (latencyMs == null || !(latencyMs >= 0)) return;
  latencyEwma.set(dep.id, nextLatencyEwma(latencyEwma.get(dep.id), latencyMs));
}

export function defaultBase(dep: ResolvedDeployment): string {
  const spec = PROVIDER_CATALOG.find((item) => item.kind === dep.kind);
  const pinned = spec?.auth === "sign_in" ? spec.default_base_url : "";
  const base = pinned || dep.base_url || dep.provider?.baseUrl || spec?.default_base_url || "";
  if (!base) throw new Error(`deployment ${dep.id} has no base URL`);
  return base.replace(/\/$/, "");
}

export function openaiRoot(base: string): string {
  const trimmed = base.replace(/\/$/, "");
  if (trimmed.endsWith("/v1")) return trimmed;
  if (trimmed.includes("anthropic.com")) return trimmed;
  return `${trimmed}/v1`;
}

export function aliasChain(model: string, body: Record<string, unknown>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string") {
      const alias = modelAlias(value);
      if (!alias || seen.has(alias)) return;
      seen.add(alias);
      out.push(alias);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) add(item);
      return;
    }
    const rec = asRecord(value);
    if (rec?.model) add(rec.model);
  };
  add(model);
  add(body.fallbacks);
  add(body.fallback);
  return out;
}
