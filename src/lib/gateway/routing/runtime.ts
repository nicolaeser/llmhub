import "server-only";
import prisma from "@/lib/db/prisma";
import { accountAllowed } from "@/lib/gateway/routing/account-access";
import { readPin } from "@/lib/gateway/routing/account-affinity";
import { accountPolicies } from "@/lib/gateway/routing/account-routing";
import { isSignInKind, PROVIDER_CATALOG, reportsLimits } from "@/lib/gateway/upstreams/provider-kinds";
import {
  nextLatencyEwma,
  pickCostLowest,
  pickLatencyEwma,
  pickLeastInflight,
  pickPriority,
  pickQuotaBalanced,
  pickQuotaExpiring,
  pickQuotaSmart,
  pickRoundRobin,
  pickWeighted,
} from "@/lib/gateway/routing/router";
import { quotaBottleneckReset, quotaExhausted, quotaPressure } from "@/lib/gateway/routing/quota";
import { hydrateLimits } from "@/lib/gateway/upstreams/limit-store";
import { limitsSnapshot } from "@/lib/gateway/upstreams/subscription-limits";
import {
  asRecord,
  asStringArray,
  ERR_ALL_PAUSED,
  ERR_NO_HEALTHY,
  ERR_NOT_ASSIGNED,
  ERR_SIGNED_OUT,
  ERR_UNKNOWN_GROUP,
  isUnavailableError,
  waitingError,
} from "@/lib/gateway/core";
import { modelAlias } from "@/lib/gateway/catalog/model-alias";
import { routePermitted } from "@/lib/gateway/access/model-policy";
import { priceWindowQuery, priceWindowRates } from "@/lib/gateway/billing/price-schedule";
import { costRejection } from "@/lib/gateway/billing/cost-cap";
import { COOLDOWN_MS, cooldownEnds, recordFailure, recordSuccess } from "@/lib/gateway/routing/provider-health";
import { attachModelFacts } from "@/lib/gateway/routing/model-facts";
import type { CostFilter } from "@/types/billing";
import type {
  AccountPin,
  DeploymentRow,
  ResolvedModelGroup,
  ResolvedDeployment,
  Deployment,
  QuotaScores,
  RouterWait,
  RunRouting,
} from "@/types/routing";
import type { AccountAccess } from "@/types/providers";
import type { DeploymentRule, RoutePolicy } from "@/types/model-templates";
import { money } from "@/lib/utils/money";

const inflight = new Map<string, number>();
const latencyEwma = new Map<string, number>();
const roundRobinCursors = new Map<string, number>();

function mapDeployment(row: DeploymentRow): ResolvedDeployment {
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
    enabled: true,
    restricted: true,
    assignments: { select: { orgId: true, teamId: true, projectId: true, memberId: true, keyId: true } },
    login: { select: { status: true } },
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

export async function loadGroup(requested: string): Promise<ResolvedModelGroup> {
  const alias = modelAlias(requested);
  if (alias === "auto") {
    const rows = await prisma.deployment.findMany({
      where: { group: { enabled: true } },
      include: { provider: providerSelect },
    });
    const mapped = rows.map(mapDeployment);
    await attachModelFacts(mapped);
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
  await attachModelFacts(mapped);
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

async function healthy(
  items: ResolvedDeployment[],
): Promise<{ ready: ResolvedDeployment[]; cooling: Map<string, number> }> {
  const cooling = await cooldownEnds(items.map((d) => d.id));
  return { ready: items.filter((d) => !cooling.has(d.id)), cooling };
}

export function cooldownWait(
  items: ResolvedDeployment[],
  cooling: Map<string, number>,
  now = Date.now(),
): RouterWait | null {
  const held = items.filter((dep) => cooling.has(dep.id));
  if (!held.length) return null;
  const ends = held.map((dep) => cooling.get(dep.id)!);
  return {
    retryAt: Math.min(...ends),
    limited: held.length === items.length && ends.every((until) => until - now > COOLDOWN_MS),
    kinds: held.every(signInProvider) ? [...new Set(held.map((dep) => dep.provider!.kind))] : [],
  };
}

export function mergeWait(a: RouterWait | null, b: RouterWait | null): RouterWait | null {
  if (!a || !b) return a ?? b;
  return {
    retryAt: Math.min(a.retryAt, b.retryAt),
    limited: a.limited && b.limited,
    kinds: a.kinds.length && b.kinds.length ? [...new Set([...a.kinds, ...b.kinds])] : [],
  };
}

function pick(items: ResolvedDeployment[], strategy: string, scores: QuotaScores): ResolvedDeployment {
  switch (strategy) {
    case "round_robin":
      return pickRoundRobin(items, roundRobinCursors);
    case "quota_balanced":
      return pickQuotaBalanced(items, scores, inflight);
    case "quota_expiring":
      return pickQuotaExpiring(items, scores, inflight);
    case "smart":
      return pickQuotaSmart(items, scores, inflight);
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

function limitedProvider(dep: ResolvedDeployment) {
  return dep.provider && reportsLimits(dep.provider.kind) ? dep.provider : null;
}

async function withinQuota(
  items: ResolvedDeployment[],
): Promise<{ items: ResolvedDeployment[]; scores: QuotaScores }> {
  const scores: QuotaScores = new Map();
  const providers = items.flatMap((dep) => limitedProvider(dep) ?? []);
  if (!providers.length) return { items, scores };
  await hydrateLimits(providers.map((provider) => provider.id));
  const now = Date.now();
  const open = items.filter((dep) => {
    const provider = limitedProvider(dep);
    if (!provider) return true;
    const limits = limitsSnapshot(provider.id);
    scores.set(dep.id, {
      pressure: quotaPressure(limits, dep.model, now),
      reset: quotaBottleneckReset(limits, dep.model, now),
    });
    return !quotaExhausted(limits, dep.model, now);
  });
  return { items: open.length ? open : items, scores };
}

async function byAccountPolicy(items: ResolvedDeployment[], scores: QuotaScores): Promise<ResolvedDeployment[]> {
  if (!items.some((dep) => isSignInKind(dep.provider?.kind ?? ""))) return items;
  const policies = await accountPolicies();
  const kept: ResolvedDeployment[] = [];
  const accounts = new Map<string, ResolvedDeployment[]>();
  for (const dep of items) {
    const kind = dep.provider?.kind ?? "";
    const policy = policies.get(kind);
    if (!policy || policy === "inherit") {
      kept.push(dep);
      continue;
    }
    accounts.set(kind, [...(accounts.get(kind) ?? []), dep]);
  }
  for (const [kind, deps] of accounts) kept.push(pick(deps, policies.get(kind)!, scores));
  return kept;
}

function affordable(
  group: ResolvedModelGroup,
  ready: ResolvedDeployment[],
  cost: CostFilter | undefined,
): ResolvedDeployment[] {
  if (!cost) return ready;
  const estimates = ready.map((dep) => cost.estimate(dep, group));
  const fitting = ready.filter((_, index) => estimates[index]! <= cost.cap.limit);
  if (!fitting.length) throw costRejection(cost.cap, Math.min(...estimates));
  return fitting;
}

function untried(items: ResolvedDeployment[], run: RunRouting | null): ResolvedDeployment[] {
  if (!run?.tried.size) return items;
  return items.filter((dep) => !run.tried.has(dep.id));
}

async function runPins(items: ResolvedDeployment[], session: string): Promise<Map<string, AccountPin>> {
  const kinds = [...new Set(items.flatMap((dep) => (signInProvider(dep) ? [dep.provider!.kind] : [])))];
  const found = new Map<string, AccountPin>();
  if (!session) return found;
  for (const kind of kinds) {
    const pin = await readPin(kind, session);
    if (pin) found.set(kind, pin);
  }
  return found;
}

function signInProvider(dep: ResolvedDeployment): boolean {
  return Boolean(dep.provider && isSignInKind(dep.provider.kind));
}

function signedIn(dep: ResolvedDeployment): boolean {
  return !signInProvider(dep) || dep.provider!.login?.status === "active";
}

function pinnedChoice(items: ResolvedDeployment[], pins: Map<string, AccountPin>): ResolvedDeployment[] {
  return items.filter((dep) => signInProvider(dep) && pins.get(dep.provider!.kind)?.providerId === dep.provider!.id);
}

function pinnedKinds(items: ResolvedDeployment[], pins: Map<string, AccountPin>): ResolvedDeployment[] {
  const kept = items.filter((dep) => signInProvider(dep) && pins.has(dep.provider!.kind));
  return kept.length ? kept : items;
}

export async function acquireGroup(
  group: ResolvedModelGroup,
  rules: DeploymentRule[] | undefined,
  serves: (dep: ResolvedDeployment) => boolean = () => true,
  strategy = "",
  cost?: CostFilter,
  access: AccountAccess | null = null,
  run: RunRouting | null = null,
): Promise<{ dep: ResolvedDeployment; release: () => void; overflow: boolean; pinned: AccountPin | null }> {
  const permitted = permittedDeployments(group.mapped, rules).filter(serves);
  const active = permitted.filter((dep) => dep.provider?.enabled !== false);
  const allowed = active.filter((dep) => accountAllowed(dep.provider, access));
  const usable = allowed.filter(signedIn);
  const health = await healthy(usable);
  const ready = untried(health.ready, run);
  if (!ready.length) {
    const wait = cooldownWait(usable, health.cooling);
    if (group.overflow_group && group.overflow_group !== group.alias) {
      const overflow = await loadGroup(group.overflow_group);
      try {
        const acquired = await acquireGroup(overflow, rules, serves, strategy, cost, access, run);
        return { ...acquired, overflow: true };
      } catch (err) {
        const merged = isUnavailableError(err) ? mergeWait(wait, err.wait) : null;
        throw merged ? waitingError(merged) : err;
      }
    }
    if (permitted.length && !active.length) throw ERR_ALL_PAUSED;
    if (active.length && !allowed.length) throw ERR_NOT_ASSIGNED;
    if (allowed.length && !usable.length) throw ERR_SIGNED_OUT;
    throw wait ? waitingError(wait) : ERR_NO_HEALTHY;
  }
  const quota = await withinQuota(affordable(group, ready, cost));
  const pins = await runPins(quota.items, run?.session ?? "");
  const sticky = pinnedChoice(quota.items, pins);
  const candidates = sticky.length ? sticky : await byAccountPolicy(pinnedKinds(quota.items, pins), quota.scores);
  const dep = pick(candidates, strategy || group.strategy, quota.scores);
  inflight.set(dep.id, (inflight.get(dep.id) ?? 0) + 1);
  let released = false;
  return {
    dep,
    overflow: false,
    pinned: signInProvider(dep) ? (pins.get(dep.provider!.kind) ?? null) : null,
    release: () => {
      if (released) return;
      released = true;
      const left = (inflight.get(dep.id) ?? 1) - 1;
      if (left > 0) inflight.set(dep.id, left);
      else inflight.delete(dep.id);
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

function isAnthropicHost(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const host = new URL(url).hostname;
  return host === "anthropic.com" || host.endsWith(".anthropic.com");
}

export function openaiRoot(base: string): string {
  const trimmed = base.replace(/\/$/, "");
  if (trimmed.endsWith("/v1")) return trimmed;
  if (isAnthropicHost(trimmed)) return trimmed;
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
