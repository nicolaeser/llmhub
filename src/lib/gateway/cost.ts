import type {
  BillingContext,
  CacheTokens,
  CostRates,
  Deployment,
  PriceFactors,
  Usage,
} from "@/types/gateway";

const TOKEN_FALLBACK = 0.000002;
const CACHE_READ_RATE = 0.1;
const CACHE_WRITE_RATE = 1.25;
const CACHE_WRITE_1H_RATE = 2;
const PREMIUM_TIER_RATE = 2;
const FLEX_TIER_RATE = 0.5;
const ANTHROPIC_FAST_RATE = 2;
const US_INFERENCE_RATE = 1.1;
const OPENAI_LONG_CONTEXT = { threshold: 272_000, input: 2, output: 1.5 };
const PREMIUM_TIERS = new Set(["priority", "fast", "ultrafast"]);
const TIERED_KINDS = new Set(["openai", "xai", "openrouter", "openrouter_eu"]);
export const REPORTED_COST_KINDS = new Set(["openrouter", "openrouter_eu"]);

function modelName(dep: Deployment | null | undefined): string {
  return (dep?.model ?? "").toLowerCase();
}

function cacheReadRate(model: string): number {
  if (/claude-(?:fable|mythos)-5[-.]1(?![0-9])/.test(model)) return 0.025;
  if (/claude-opus-5[-.]5(?![0-9])/.test(model)) return 0.05;
  return CACHE_READ_RATE;
}

function tierRate(dep: Deployment, usage: Partial<Usage>): number {
  if (dep.kind === "anthropic") {
    return (
      (usage.speed === "fast" ? ANTHROPIC_FAST_RATE : 1) *
      (usage.inference_geo === "us" ? US_INFERENCE_RATE : 1)
    );
  }
  if (!TIERED_KINDS.has(dep.kind)) return 1;
  if (PREMIUM_TIERS.has(usage.service_tier ?? "")) return PREMIUM_TIER_RATE;
  if (usage.service_tier === "flex") return FLEX_TIER_RATE;
  return 1;
}

export function priceFactors(dep: Deployment | null | undefined, usage: Partial<Usage>): PriceFactors {
  const model = modelName(dep);
  const tier = dep ? tierRate(dep, usage) : 1;
  const longContext =
    dep?.kind === "openai" &&
    /^gpt-5\.6(?![0-9])/.test(model) &&
    (usage.prompt_tokens ?? 0) > OPENAI_LONG_CONTEXT.threshold;
  return {
    input: tier * (longContext ? OPENAI_LONG_CONTEXT.input : 1),
    output: tier * (longContext ? OPENAI_LONG_CONTEXT.output : 1),
    cacheRead: cacheReadRate(model),
  };
}

function averageCostRates(peers: CostRates[]): CostRates | null {
  if (!peers.length) return null;
  const n = peers.length;
  return {
    cost_input_per_1k:
      peers.reduce((sum, row) => sum + row.cost_input_per_1k, 0) / n,
    cost_output_per_1k:
      peers.reduce((sum, row) => sum + row.cost_output_per_1k, 0) / n,
  };
}

export function cacheTokens(usage: Partial<Usage>): CacheTokens {
  const prompt = usage.prompt_tokens ?? 0;
  const read = Math.min(prompt, usage.cache_read_input_tokens ?? 0);
  const written = Math.min(prompt - read, usage.cache_creation_input_tokens ?? 0);
  const writtenLong = Math.min(written, usage.cache_creation_1h_input_tokens ?? 0);
  return { read, written, writtenLong };
}

function rawCost(
  rates: CostRates | null | undefined,
  usage: Partial<Usage>,
  factors: PriceFactors,
): number {
  if (!rates) return 0;
  const prompt = usage.prompt_tokens ?? 0;
  const completion = usage.completion_tokens ?? 0;
  const { read: cached, written, writtenLong } = cacheTokens(usage);
  const billed = Math.max(0, prompt - cached - written);
  const rate = (rates.cost_input_per_1k / 1000) * factors.input;
  const input = billed * rate;
  const cache = cached * rate * factors.cacheRead;
  const writes =
    (written - writtenLong) * rate * CACHE_WRITE_RATE + writtenLong * rate * CACHE_WRITE_1H_RATE;
  const output = (completion / 1000) * rates.cost_output_per_1k * factors.output;
  return input + cache + writes + output;
}

function withTokenFallback(sum: number, usage: Partial<Usage>): number {
  const prompt = usage.prompt_tokens ?? 0;
  const completion = usage.completion_tokens ?? 0;
  if (sum === 0 && prompt + completion > 0) {
    return (prompt + completion) * TOKEN_FALLBACK;
  }
  return sum;
}

export function costOf(
  dep: Deployment | null | undefined,
  usage: Partial<Usage>,
  opts?: Partial<BillingContext>,
): number {
  if (!dep) return 0;
  const factors = priceFactors(dep, usage);
  if (opts?.mode === "custom" && opts.price) return rawCost(opts.price, usage, factors);
  const reported = REPORTED_COST_KINDS.has(dep.kind) ? usage.cost : undefined;
  const routed = reported ?? rawCost(dep, usage, factors);
  const average =
    (opts?.mode ?? "routed") === "average"
      ? averageCostRates(opts?.peers?.length ? opts.peers : [dep])
      : null;
  const sum = average ? Math.max(rawCost(average, usage, factors), routed) : routed;
  return reported === undefined ? withTokenFallback(sum, usage) : sum;
}

export function cacheSavingsOf(
  dep: Deployment | null | undefined,
  usage: Partial<Usage>,
  opts?: Partial<BillingContext>,
): number {
  const estimated = { ...usage, cost: undefined };
  const uncached = {
    ...estimated,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_creation_1h_input_tokens: 0,
  };
  return costOf(dep, uncached, opts) - costOf(dep, estimated, opts);
}
