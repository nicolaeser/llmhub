import { asRecord } from "@/lib/gateway/core";
import { costOf } from "@/lib/gateway/cost";
import { GateError } from "@/lib/gateway/errors";
import { isOpaqueText } from "@/lib/gateway/pii";
import { groupBilling } from "@/lib/gateway/price-schedule";
import { applyProviderServiceMode } from "@/lib/gateway/service-mode";
import { tokensForLength } from "@/lib/gateway/tokens";
import type {
  CostCap,
  CostFilter,
  Group,
  JsonMap,
  Principal,
  RequestTokens,
  ResolvedDeployment,
  Usage,
} from "@/types/gateway";

export const MAX_COST_HEADER = "x-hub-max-cost";

const OUTPUT_LIMIT_KEYS = ["max_tokens", "max_completion_tokens", "max_output_tokens"] as const;
const CHOICE_KEYS = ["n", "best_of"] as const;
const NON_PROMPT_KEYS = new Set([
  "model",
  "user",
  "metadata",
  "tags",
  "tag",
  "fallbacks",
  "fallback",
  "signature",
  "encrypted_content",
]);
const COST_REJECTIONS = new Set(["cost_limit_exceeded", "budget_exceeded"]);

function promptLength(value: unknown, key = ""): number {
  if (NON_PROMPT_KEYS.has(key)) return 0;
  if (typeof value === "string") return isOpaqueText(value) ? 0 : value.length;
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + promptLength(item, key), 0);
  const rec = asRecord(value);
  if (!rec) return 0;
  return Object.entries(rec).reduce((sum, [field, item]) => sum + promptLength(item, field), 0);
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0;
}

function outputLimit(body: JsonMap): number {
  for (const key of OUTPUT_LIMIT_KEYS) {
    const limit = positiveInteger(body[key]);
    if (limit) return limit;
  }
  return 0;
}

export function requestTokens(body: JsonMap): RequestTokens {
  const choices = Math.max(1, ...CHOICE_KEYS.map((key) => positiveInteger(body[key])));
  return { prompt: tokensForLength(promptLength(body)), completion: outputLimit(body) * choices };
}

export function estimateCost(
  dep: ResolvedDeployment,
  group: Group,
  body: JsonMap,
  tokens: RequestTokens,
  at: Date,
): number {
  const served = applyProviderServiceMode(dep.kind, body, group.strategy, dep.model).body;
  const usage: Partial<Usage> = {
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
