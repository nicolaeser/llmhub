import { costOf } from "@/lib/gateway/billing/cost";
import { GateError } from "@/lib/gateway/errors";
import { groupBilling } from "@/lib/gateway/billing/price-schedule";
import { routePool } from "@/lib/gateway/routing/route-pool";
import { applyProviderServiceMode } from "@/lib/gateway/dispatch/service-mode";
import { outputTokenLimit, positiveInteger, promptLength, tokensForLength } from "@/lib/gateway/billing/tokens";
import type { JsonMap, Principal } from "@/types/gateway";
import type { CostCap, CostFilter, RequestTokens, TokenUsage } from "@/types/billing";
import type { ResolvedModelGroup, ResolvedDeployment } from "@/types/routing";

export const MAX_COST_HEADER = "x-hub-max-cost";

const CHOICE_KEYS = ["n", "best_of"] as const;
const COST_REJECTIONS = new Set(["cost_limit_exceeded", "budget_exceeded"]);

export function requestTokens(body: JsonMap): RequestTokens {
  const choices = Math.max(1, ...CHOICE_KEYS.map((key) => positiveInteger(body[key])));
  return { prompt: tokensForLength(promptLength(body)), completion: outputTokenLimit(body) * choices };
}

export function estimateCost(
  dep: ResolvedDeployment,
  group: ResolvedModelGroup,
  body: JsonMap,
  tokens: RequestTokens,
  at: Date,
): number {
  if (routePool(dep) === "subscription") return 0;
  const served = applyProviderServiceMode(dep.kind, body, group.strategy, dep.model).body;
  const usage: Partial<TokenUsage> = {
    prompt_tokens: tokens.prompt,
    completion_tokens: tokens.completion,
    ...(typeof served.service_tier === "string" ? { service_tier: served.service_tier } : {}),
    ...(typeof served.speed === "string" ? { speed: served.speed } : {}),
  };
  return costOf(dep, usage, group.alias === "auto" ? undefined : groupBilling(group, at));
}

export function maxCostHeader(headers: Headers): number | null {
  const raw = headers.get(MAX_COST_HEADER);
  if (raw === null) return null;
  const value = Number(raw.trim());
  if (!raw.trim() || !Number.isFinite(value) || value <= 0) {
    throw new GateError(400, "invalid_request", `${MAX_COST_HEADER} must be a positive number`);
  }
  return value;
}

export function tighterCap(current: CostCap | null, next: CostCap): CostCap {
  return current && current.limit <= next.limit ? current : next;
}

export function capRequestCost(principal: Principal, budget: CostCap | null, maxCost: number | null): void {
  if (!principal.trace) return;
  const keyLimit = principal.key?.max_request_cost ?? 0;
  let cap = budget;
  if (keyLimit > 0) cap = tighterCap(cap, { limit: keyLimit, budget: null });
  if (maxCost !== null) cap = tighterCap(cap, { limit: maxCost, budget: null });
  principal.trace.costCap = cap;
}

export function costFilter(principal: Principal, body: JsonMap | null | undefined): CostFilter | undefined {
  const cap = principal.trace?.costCap;
  if (!cap || !body) return undefined;
  const tokens = requestTokens(body);
  const at = new Date();
  return { cap, estimate: (dep, group) => estimateCost(dep, group, body, tokens, at) };
}

function amount(value: number): string {
  return value.toFixed(6);
}

export function costRejection(cap: CostCap, estimate: number): GateError {
  if (cap.budget) {
    return new GateError(
      429,
      "budget_exceeded",
      `estimated request cost ${amount(estimate)} exceeds the remaining ${cap.budget} budget of ${amount(cap.limit)}`,
    );
  }
  return new GateError(
    400,
    "cost_limit_exceeded",
    `estimated request cost ${amount(estimate)} exceeds the per-request limit of ${amount(cap.limit)}`,
  );
}

export function costRejected(err: unknown): boolean {
  return err instanceof GateError && COST_REJECTIONS.has(err.code);
}
