import assert from "node:assert/strict";
import test from "node:test";
import {
  grantedOutput,
  limitOutput,
  MIN_OUTPUT_TOKENS,
  outputWanted,
  restoreOutput,
  snapshotOutput,
  UNSTATED_OUTPUT_TOKENS,
} from "@/lib/gateway/billing/output-fit";
import { budgetCeiling, overrunPercent, parseBudgetMode } from "@/lib/utils/budget";
import { budgetUpdateSchema } from "@/schemas/management";

test("budget ceilings: hard holds the limit, soft adds its overrun, legacy soft has none", () => {
  assert.equal(budgetCeiling(10, "hard", null), 10);
  assert.equal(budgetCeiling(10, "hard", 50), 10);
  assert.equal(budgetCeiling(10, "soft", null), null);
  assert.ok(Math.abs(budgetCeiling(10, "soft", 10)! - 11) < 1e-9);
});

test("budget modes and overrun percentages are validated", () => {
  assert.equal(parseBudgetMode("hard"), "hard");
  assert.equal(parseBudgetMode("soft"), "soft");
  assert.equal(parseBudgetMode("strict"), null);
  assert.equal(overrunPercent(null), null);
  assert.equal(overrunPercent(""), null);
  assert.equal(overrunPercent(25), 25);
  for (const bad of [0, 101, 2.5, "x", -1]) assert.equal(overrunPercent(bad), undefined, String(bad));
});

test("the management schema refuses an overrun on a hard budget", () => {
  assert.equal(budgetUpdateSchema.safeParse({ max_budget: 10, budget_mode: "hard" }).success, true);
  assert.equal(budgetUpdateSchema.safeParse({ max_budget: 10, budget_mode: "soft", overrun_percent: 10 }).success, true);
  assert.equal(budgetUpdateSchema.safeParse({ max_budget: 10, budget_mode: "soft", overrun_percent: null }).success, true);
  assert.equal(budgetUpdateSchema.safeParse({ max_budget: 10, budget_mode: "hard", overrun_percent: 10 }).success, false);
  assert.equal(budgetUpdateSchema.safeParse({ max_budget: 10, budget_mode: "loose" }).success, false);
  assert.equal(budgetUpdateSchema.safeParse({ max_budget: 10, overrun_percent: 0 }).success, false);
});

test("output wanted uses the stated limit, assumes one for open text requests, and skips other bodies", () => {
  assert.deepEqual(outputWanted({ messages: [], max_tokens: 4000 }), { perChoice: 4000, floorPerChoice: MIN_OUTPUT_TOKENS });
  assert.deepEqual(outputWanted({ messages: [] }), { perChoice: UNSTATED_OUTPUT_TOKENS, floorPerChoice: MIN_OUTPUT_TOKENS });
  assert.deepEqual(outputWanted({ messages: [], max_tokens: 300 }), { perChoice: 300, floorPerChoice: 300 });
  assert.deepEqual(
    outputWanted({ messages: [], max_tokens: 64_000, thinking: { type: "enabled", budget_tokens: 30_000 } }),
    { perChoice: 64_000, floorPerChoice: 2 * MIN_OUTPUT_TOKENS },
  );
  assert.deepEqual(outputWanted({ input: "embed me" }), { perChoice: 0, floorPerChoice: 0 });
});

test("limitOutput lowers every stated limit and keeps thinking below the new maximum", () => {
  const stated = { messages: [], max_tokens: 64_000, max_completion_tokens: 2_000, thinking: { type: "enabled", budget_tokens: 32_000 } };
  limitOutput(stated, 5_000, "anthropic");
  assert.equal(stated.max_tokens, 5_000);
  assert.equal(stated.max_completion_tokens, 2_000);
  assert.deepEqual(stated.thinking, { type: "enabled", budget_tokens: 5_000 - MIN_OUTPUT_TOKENS });

  const adaptive = { messages: [], max_tokens: 64_000, thinking: { type: "adaptive" } };
  limitOutput(adaptive, 3_000, "claude");
  assert.deepEqual(adaptive, { messages: [], max_tokens: 3_000, thinking: { type: "adaptive" } });
});

test("limitOutput adds the limit field the target understands when the caller sent none", () => {
  const openai: Record<string, unknown> = { messages: [] };
  limitOutput(openai, 1_500, "openai");
  assert.equal(openai.max_completion_tokens, 1_500);
  assert.equal("max_tokens" in openai, false);

  const compat: Record<string, unknown> = { messages: [] };
  limitOutput(compat, 1_500, "openai_compat");
  assert.equal(compat.max_tokens, 1_500);

  const responses: Record<string, unknown> = { input: "hi", max_output_tokens: 9_000 };
  limitOutput(responses, 1_500, "openai");
  assert.equal(responses.max_output_tokens, 1_500);
});

test("snapshots restore the caller's output fields before the next attempt", () => {
  const thinking = { type: "enabled", budget_tokens: 32_000 };
  const body: Record<string, unknown> = { messages: [], max_tokens: 64_000, thinking };
  const snapshot = snapshotOutput(body);
  limitOutput(body, 2_048, "anthropic");
  body.max_completion_tokens = 7;
  restoreOutput(body, snapshot);
  assert.deepEqual(body, { messages: [], max_tokens: 64_000, thinking });
  assert.equal(body.thinking, thinking);

  const open: Record<string, unknown> = { messages: [] };
  const empty = snapshotOutput(open);
  limitOutput(open, 2_048, "openai");
  restoreOutput(open, empty);
  assert.deepEqual(open, { messages: [] });
});

test("grantedOutput scales the output to the granted amount", () => {
  assert.equal(grantedOutput(1, 0.1, 1, 10_000), 10_000);
  assert.equal(grantedOutput(2, 0.1, 1, 10_000), 10_000);
  assert.equal(grantedOutput(0.55, 0.1, 1, 10_000), 5_000);
  assert.equal(grantedOutput(0.5, 0.5, 0.5, 10_000), 10_000);
  assert.equal(grantedOutput(0.05, 0.1, 1, 10_000), 0);
});
