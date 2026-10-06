import assert from "node:assert/strict";
import test from "node:test";
import { costOf } from "@/lib/gateway/cost";
import {
  catalogPricesOf,
  parsePricing,
  priceForUpstream,
} from "@/lib/gateway/provider-prices";
import type { Deployment } from "@/types/gateway";

function deployment(
  over: Partial<Deployment> & Pick<Deployment, "id">,
): Deployment {
  return {
    kind: "openai",
    base_url: "https://example.invalid/v1",
    model: "m",
    weight: 1,
    cost_input_per_1k: 0,
    cost_output_per_1k: 0,
    provider_id: "",
    ...over,
  };
}

const usage = { prompt_tokens: 1000, completion_tokens: 1000 };

test("routed bills the serving deployment rates", () => {
  const serving = deployment({
    id: "serve",
    cost_input_per_1k: 2,
    cost_output_per_1k: 4,
  });
  const peers = [
    serving,
    deployment({ id: "other", cost_input_per_1k: 9, cost_output_per_1k: 9 }),
  ];
  assert.equal(costOf(serving, usage), 6);
  assert.equal(costOf(serving, usage, { mode: "routed", peers }), 6);
});

test("average bills the unweighted mean of group rates", () => {
  const serving = deployment({
    id: "cheap",
    cost_input_per_1k: 2,
    cost_output_per_1k: 4,
  });
  const peers = [
    serving,
    deployment({ id: "mid", cost_input_per_1k: 6, cost_output_per_1k: 8 }),
  ];
  assert.equal(costOf(serving, usage, { mode: "average", peers }), 10);
});

test("average is a floor when the serving deployment is cheaper", () => {
  const serving = deployment({
    id: "cheap",
    cost_input_per_1k: 1,
    cost_output_per_1k: 1,
  });
  const peers = [
    serving,
    deployment({ id: "pricey", cost_input_per_1k: 5, cost_output_per_1k: 5 }),
  ];
  assert.equal(costOf(serving, usage, { mode: "average", peers }), 6);
});

test("average floor uses the serving price when it is higher than the mean", () => {
  const serving = deployment({
    id: "pricey",
    cost_input_per_1k: 8,
    cost_output_per_1k: 8,
  });
  const peers = [
    serving,
    deployment({ id: "cheap", cost_input_per_1k: 2, cost_output_per_1k: 2 }),
  ];
  assert.equal(costOf(serving, usage, { mode: "average", peers }), 16);
});

test("zero rates apply the token fallback once, not twice", () => {
  const serving = deployment({ id: "a" });
  const peers = [serving, deployment({ id: "b" })];
  const expected = 2000 * 0.000002;
  assert.equal(costOf(serving, usage, { mode: "average", peers }), expected);
  assert.equal(costOf(serving, usage, { mode: "routed", peers }), expected);
});

test("average does not take the token fallback over a real mean", () => {
  const serving = deployment({ id: "free" });
  const peers = [
    serving,
    deployment({ id: "priced", cost_input_per_1k: 1, cost_output_per_1k: 1 }),
  ];
  assert.equal(costOf(serving, usage, { mode: "average", peers }), 1);
});

test("missing deployment stays 0 without tokens", () => {
  assert.equal(costOf(null, {}), 0);
  assert.equal(costOf(undefined, { prompt_tokens: 0, completion_tokens: 0 }), 0);
  assert.equal(costOf(null, usage, { mode: "average", peers: [] }), 0);
});

test("missing deployment stays 0 even when tokens exist", () => {
  assert.equal(costOf(null, usage), 0);
});

test("empty average peers fall back to routed serving cost", () => {
  const serving = deployment({
    id: "solo",
    cost_input_per_1k: 3,
    cost_output_per_1k: 1,
  });
  assert.equal(costOf(serving, usage, { mode: "average", peers: [] }), 4);
});

test("parsePricing converts OpenRouter per-token strings to per-1k", () => {
  const priced = parsePricing({ prompt: "0.000002", completion: "0.00001" });
  assert.deepEqual(priced, { in: 0.002, out: 0.01 });
  const alreadyPer1k = parsePricing({ input: 0.5, output: 1.5 });
  assert.deepEqual(alreadyPer1k, { in: 0.5, out: 1.5 });
  assert.equal(parsePricing({}), null);
});

test("catalog prices skip unpaid models and match suffix ids", () => {
  const rows = catalogPricesOf([
    { id: "skip", costInputPer1k: 0, costOutputPer1k: 0 },
    {
      id: "openrouter/google/gemini-flash",
      costInputPer1k: 0.1,
      costOutputPer1k: 0.4,
    },
  ]);
  assert.equal(rows.length, 1);
  const hit = priceForUpstream(rows, "gemini-flash");
  assert.equal(hit?.costInput, 0.1);
  assert.equal(hit?.costOutput, 0.4);
  assert.equal(priceForUpstream(rows, "missing"), null);
});
