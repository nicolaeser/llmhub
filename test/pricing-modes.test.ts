import assert from "node:assert/strict";
import test from "node:test";
import { chatToAnthropic, chatUsageFromAnthropic } from "@/lib/gateway/anthropic";
import { usageFromUnknown } from "@/lib/gateway/billing";
import { cacheSavingsOf, cacheTokens, costOf, priceFactors } from "@/lib/gateway/cost";
import { xaiReasoningEffort } from "@/lib/gateway/upstream";
import type { Deployment, Usage } from "@/types/gateway";

function dep(kind: string, model: string, input = 1, output = 2): Deployment {
  return {
    id: `${kind}:${model}`,
    kind,
    base_url: "",
    model,
    weight: 1,
    cost_input_per_1k: input,
    cost_output_per_1k: output,
    provider_id: "",
  };
}

const base: Partial<Usage> = { prompt_tokens: 1000, completion_tokens: 1000 };

function close(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
}

test("OpenAI, xAI, and OpenRouter bill the tier that served the request", () => {
  const openai = dep("openai", "gpt-5.6-sol");
  close(costOf(openai, base), 3);
  close(costOf(openai, { ...base, service_tier: "priority" }), 6);
  close(costOf(openai, { ...base, service_tier: "fast" }), 6);
  close(costOf(openai, { ...base, service_tier: "flex" }), 1.5);
  close(costOf(openai, { ...base, service_tier: "default" }), 3);
  close(costOf(dep("xai", "grok-4.7"), { ...base, service_tier: "priority" }), 6);
  close(costOf(dep("openrouter", "openai/gpt-5.6-sol"), { ...base, service_tier: "flex" }), 1.5);
  close(costOf(dep("openai_compat", "groq/llama"), { ...base, service_tier: "flex" }), 3);
});

test("Anthropic fast mode, US inference, and per-model cache reads are priced", () => {
  const opus = dep("anthropic", "claude-opus-5-5", 4, 20);
  close(costOf(opus, base), 24);
  close(costOf(opus, { ...base, speed: "fast" }), 48);
  close(costOf(opus, { ...base, inference_geo: "us" }), 26.4);
  close(costOf(opus, { ...base, speed: "fast", inference_geo: "us" }), 52.8);
  close(costOf(opus, { ...base, service_tier: "priority" }), 24);
  assert.equal(priceFactors(opus, base).cacheRead, 0.05);
  assert.equal(priceFactors(dep("anthropic", "claude-fable-5-1"), base).cacheRead, 0.025);
  assert.equal(priceFactors(dep("anthropic", "claude-sonnet-5-5"), base).cacheRead, 0.1);
  close(costOf(opus, { prompt_tokens: 1000, completion_tokens: 0, cache_read_input_tokens: 1000 }), 0.2);
});

test("GPT-5.6 long context doubles input and adds half to output above 272K", () => {
  const gpt = dep("openai", "gpt-5.6-sol", 4, 20);
  const long = { prompt_tokens: 300_000, completion_tokens: 1000 };
  close(costOf(gpt, long), 300 * 4 * 2 + 20 * 1.5);
  close(costOf(gpt, { prompt_tokens: 272_000, completion_tokens: 1000 }), 272 * 4 + 20);
  close(costOf(gpt, { ...long, service_tier: "fast" }), (300 * 4 * 2 + 20 * 1.5) * 2);
  close(costOf(dep("openai", "gpt-5.4", 4, 20), long), 300 * 4 + 20);
});

test("OpenRouter's reported cost wins, including BYOK upstream cost and free models", () => {
  const router = dep("openrouter", "anthropic/claude-opus-5-5", 4, 20);
  const reported = usageFromUnknown({
    prompt_tokens: 1000,
    completion_tokens: 1000,
    cost: 0.03,
    cost_details: { upstream_inference_cost: 0.02 },
  });
  close(costOf(router, reported), 0.05);
  close(costOf(router, usageFromUnknown({ prompt_tokens: 10, completion_tokens: 10, cost: 0 })), 0);
  close(costOf(dep("openai", "gpt-5.6-sol"), { ...base, cost: 0.01 }), 3);
});

test("a custom model price replaces endpoint and reported cost but keeps cache and tier rules", () => {
  const price = { cost_input_per_1k: 0.5, cost_output_per_1k: 1.5 };
  const custom = { mode: "custom", peers: [], price };
  close(costOf(dep("openai_compat", "self-hosted/llama", 0, 0), base, custom), 2);
  close(costOf(dep("openai_compat", "self-hosted/llama", 0, 0), base, { mode: "routed", peers: [], price }), 0.004);
  const router = dep("openrouter", "anthropic/claude-opus-5-5", 4, 20);
  close(costOf(router, usageFromUnknown({ prompt_tokens: 1000, completion_tokens: 1000, cost: 0.03 }), custom), 2);
  close(costOf(dep("openai", "gpt-5.6-sol"), { ...base, service_tier: "flex" }, custom), 1);
  close(
    costOf(dep("openai_compat", "self-hosted/llama"), { prompt_tokens: 1000, completion_tokens: 0, cache_read_input_tokens: 1000 }, custom),
    0.05,
  );
  const free = { mode: "custom", peers: [], price: { cost_input_per_1k: 0, cost_output_per_1k: 0 } };
  close(costOf(dep("openai_compat", "self-hosted/llama", 0, 0), base, free), 0);
});

test("cache tokens stay inside the prompt and savings net cache writes against reads", () => {
  assert.deepEqual(
    cacheTokens({ prompt_tokens: 100, cache_read_input_tokens: 70, cache_creation_input_tokens: 50, cache_creation_1h_input_tokens: 40 }),
    { read: 70, written: 30, writtenLong: 30 },
  );
  const sonnet = dep("anthropic", "claude-sonnet-5-5");
  close(cacheSavingsOf(sonnet, { prompt_tokens: 1000, completion_tokens: 0, cache_read_input_tokens: 1000 }), 0.9);
  close(cacheSavingsOf(sonnet, { prompt_tokens: 1000, completion_tokens: 0, cache_creation_input_tokens: 1000 }), -0.25);
  close(cacheSavingsOf(sonnet, base), 0);
  close(cacheSavingsOf(null, { prompt_tokens: 1000, completion_tokens: 0, cache_read_input_tokens: 1000 }), 0);
  const router = dep("openrouter", "anthropic/claude-opus-5-5", 4, 20);
  close(
    cacheSavingsOf(router, { prompt_tokens: 1000, completion_tokens: 0, cache_read_input_tokens: 1000, cost: 0.2 }),
    3.8,
  );
});

test("reasoning tokens reported outside completion_tokens are billed as output", () => {
  const xai = usageFromUnknown({
    prompt_tokens: 663,
    completion_tokens: 50,
    total_tokens: 837,
    completion_tokens_details: { reasoning_tokens: 124 },
  });
  assert.equal(xai.completion_tokens, 174);
  assert.equal(xai.total_tokens, 837);
  const gemini = usageFromUnknown({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 400 });
  assert.equal(gemini.completion_tokens, 300);
  const openai = usageFromUnknown({
    prompt_tokens: 100,
    completion_tokens: 500,
    total_tokens: 600,
    completion_tokens_details: { reasoning_tokens: 400 },
  });
  assert.equal(openai.completion_tokens, 500);
  const cachedOutsidePrompt = usageFromUnknown({
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 170,
    prompt_tokens_details: { cached_tokens: 50 },
  });
  assert.equal(cachedOutsidePrompt.completion_tokens, 20);
});

test("served tier, speed, and inference geography are read from the response", () => {
  assert.equal(usageFromUnknown({ prompt_tokens: 1 }, { service_tier: "Priority" }).service_tier, "priority");
  const claude = usageFromUnknown(
    chatUsageFromAnthropic({
      input_tokens: 10,
      output_tokens: 5,
      service_tier: "standard",
      speed: "fast",
      inference_geo: "us",
    }),
  );
  assert.equal(claude.speed, "fast");
  assert.equal(claude.inference_geo, "us");
  assert.equal(claude.service_tier, "standard");
  assert.deepEqual(Object.keys(usageFromUnknown({ prompt_tokens: 1, completion_tokens: 1 })).sort(), [
    "cache_creation_1h_input_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "completion_tokens",
    "prompt_tokens",
    "total_tokens",
  ]);
});

test("effort levels are clamped to what each provider model accepts", () => {
  const sonnet46 = chatToAnthropic({ model: "claude-sonnet-4-6", messages: [], reasoning_effort: "xhigh" });
  assert.deepEqual(sonnet46.output_config, { effort: "high" });
  const opus47 = chatToAnthropic({ model: "claude-opus-4-7", messages: [], reasoning_effort: "xhigh" });
  assert.deepEqual(opus47.output_config, { effort: "xhigh" });
  assert.equal(xaiReasoningEffort("grok-4.5", "xhigh"), "high");
  assert.equal(xaiReasoningEffort("grok-4.7", "max"), "xhigh");
  assert.equal(xaiReasoningEffort("grok-4.6", "minimal"), "low");
  assert.equal(xaiReasoningEffort("grok-4.7", "medium"), "medium");
  assert.equal(xaiReasoningEffort("grok-3-mini", "minimal"), "minimal");
  assert.equal(xaiReasoningEffort("grok-4-0709", "minimal"), "minimal");
});
