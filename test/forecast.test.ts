import assert from "node:assert/strict";
import test from "node:test";
import { crossedThresholds, forecastBudget, spendWindow } from "@/lib/gateway/forecast";

const DAY = 86_400_000;

test("spendWindow measures days since the last reset and until the next", () => {
  const now = new Date("2026-10-06T00:00:00Z");
  const reset = new Date(now.getTime() - 3 * DAY);
  const created = new Date(now.getTime() - 40 * DAY);
  assert.deepEqual(spendWindow({ budgetDuration: "7d", spendResetAt: reset, createdAt: created }, now), {
    elapsedDays: 3,
    remainingDays: 4,
  });
  assert.deepEqual(spendWindow({ budgetDuration: "", spendResetAt: null, createdAt: created }, now), {
    elapsedDays: 40,
    remainingDays: null,
  });
});

test("forecastBudget does not report exhaustion after the window resets", () => {
  assert.equal(forecastBudget(30, 100, 3, 4).daysToExhaust, null);
  assert.equal(forecastBudget(30, 100, 3, 30).daysToExhaust, 7);
  assert.equal(forecastBudget(30, 100, 3).projectedMonth, 300);
});

test("forecastBudget projects from window average", () => {
  const f = forecastBudget(100, 400, 10);
  assert.equal(f.dailyAvg, 10);
  assert.equal(f.projectedMonth, 300);
  assert.equal(f.daysToExhaust, 30);
  assert.equal(f.pctUsed, 0.25);
});

test("forecastBudget is null without a cap", () => {
  const f = forecastBudget(50, 0, 7);
  assert.equal(f.daysToExhaust, null);
  assert.equal(f.pctUsed, null);
});

test("crossedThresholds lists every passed percent", () => {
  assert.deepEqual(crossedThresholds(0.85, [50, 80, 100]), [50, 80]);
  assert.deepEqual(crossedThresholds(null, [50]), []);
});
