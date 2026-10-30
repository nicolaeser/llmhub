import assert from "node:assert/strict";
import test from "node:test";
import {
  ATTENTION_LIMIT,
  capRatio,
  failingProviders,
  nearCap,
  nextStep,
  orderSteps,
  rankAttention,
} from "@/lib/console/overview-view";
import type { OverviewAttention } from "@/types/console";
import type { DeploymentHealthView } from "@/types/provider-health";

function deployment(input: Partial<DeploymentHealthView> & Pick<DeploymentHealthView, "provider">): DeploymentHealthView {
  return {
    id: input.provider,
    alias: "gpt",
    model: "gpt",
    kind: "openai",
    attempts: 0,
    failures: 0,
    errorRate: 0,
    p50: null,
    p95: null,
    trips: 0,
    cooldownUntil: null,
    ...input,
  };
}

test("a budget is near its cap from 80 percent and never without a cap", () => {
  assert.equal(capRatio(5, 0), null);
  assert.equal(nearCap(capRatio(79, 100)), false);
  assert.equal(nearCap(capRatio(80, 100)), true);
  assert.equal(nearCap(capRatio(120, 100)), true);
  assert.equal(nearCap(null), false);
});

test("providers count as failing while cooling down or after repeated errors", () => {
  const now = 1_000;
  const rows = [
    deployment({ provider: "Healthy", attempts: 40, failures: 1, errorRate: 0.025 }),
    deployment({ provider: "Flaky", attempts: 4, failures: 3, errorRate: 0.75 }),
    deployment({ provider: "Flaky", attempts: 2, failures: 2, errorRate: 1 }),
    deployment({ provider: "Paused", cooldownUntil: now + 10 }),
    deployment({ provider: "Recovered", cooldownUntil: now - 10 }),
    deployment({ provider: "Sparse", attempts: 2, failures: 2, errorRate: 1 }),
  ];
  assert.deepEqual(failingProviders(rows, now), [
    { name: "Paused", failures: 0, cooling: true },
    { name: "Flaky", failures: 3, cooling: false },
  ]);
});

test("attention lists exhausted budgets and paused providers first and stays short", () => {
  const errors: OverviewAttention = { kind: "errors", id: "errors", count: 3, href: "/logs" };
  const near: OverviewAttention = { kind: "budget", id: "near", target: "key", name: "a", ratio: 0.9, href: null };
  const over: OverviewAttention = { kind: "budget", id: "over", target: "company", name: "b", ratio: 1.2, href: null };
  const paused: OverviewAttention = { kind: "provider", id: "paused", name: "p", failures: 0, cooling: true, href: null };
  assert.deepEqual(rankAttention([errors, near, over, paused]).map((item) => item.id), ["over", "paused", "near", "errors"]);
  const many = Array.from({ length: ATTENTION_LIMIT + 3 }, (_, index) => ({ ...near, id: `n${index}` }));
  assert.equal(rankAttention(many).length, ATTENTION_LIMIT);
});

test("setup steps keep the product order and point at the first open step", () => {
  const steps = orderSteps([
    { id: "key", done: false, href: "/keys" },
    { id: "provider", done: true, href: "/providers" },
    { id: "request", done: false, href: null },
  ]);
  assert.deepEqual(steps.map((step) => step.id), ["provider", "key", "request"]);
  assert.equal(nextStep(steps)?.id, "key");
  assert.equal(nextStep(steps.map((step) => ({ ...step, done: true }))), null);
});
