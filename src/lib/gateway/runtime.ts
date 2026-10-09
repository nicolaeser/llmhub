import "server-only";
import prisma from "@/lib/db/prisma";
import { open } from "@/lib/crypto";
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
import { coolingDown, recordFailure, recordSuccess } from "@/lib/gateway/provider-health";
import type { DbDeployment, ResolvedDeployment, Deployment, ModelGroup } from "@/types/gateway";
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

export async function loadGroup(requested: string): Promise<ModelGroup & { mapped: ResolvedDeployment[] }> {
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

export async function acquireGroup(
  group: ModelGroup & { mapped: ResolvedDeployment[] },
  rules: DeploymentRule[] | undefined,
  exclude: Set<string> = new Set(),
  strategy = "",
): Promise<{ dep: ResolvedDeployment; release: () => void; overflow: boolean }> {
  const ready = await healthy(
    permittedDeployments(group.mapped, rules).filter((d) => !exclude.has(d.id)),
  );
  if (!ready.length) {
    if (group.overflow_group && group.overflow_group !== group.alias) {
      const overflow = await loadGroup(group.overflow_group);
      const acquired = await acquireGroup(overflow, rules, exclude, strategy);
      return { ...acquired, overflow: true };
    }
    throw ERR_NO_HEALTHY;
  }
  const dep = pick(ready, strategy || group.strategy);
  inflight.set(dep.id, (inflight.get(dep.id) ?? 0) + 1);
  return {
    dep,
    overflow: false,
    release: () => {
      inflight.set(dep.id, Math.max(0, (inflight.get(dep.id) ?? 1) - 1));
    },
  };
}

export function markFailure(dep: Deployment): void {
  recordFailure(dep.id);
}

export function markSuccess(dep: Deployment, latencyMs?: number): void {
  recordSuccess(dep.id, latencyMs);
  if (latencyMs == null || !(latencyMs >= 0)) return;
  latencyEwma.set(dep.id, nextLatencyEwma(latencyEwma.get(dep.id), latencyMs));
}

export function secretFor(dep: ResolvedDeployment): string {
  return dep.provider ? open(dep.provider.apiKey) : "";
}

export function defaultBase(dep: ResolvedDeployment): string {
  const base =
    dep.base_url ||
    dep.provider?.baseUrl ||
    PROVIDER_CATALOG.find((spec) => spec.kind === dep.kind)?.default_base_url ||
    "";
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
