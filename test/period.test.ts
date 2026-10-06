import assert from "node:assert/strict";
import test from "node:test";
import {
  capExceeded,
  parseBudgetDurationMs,
  periodElapsed,
} from "@/lib/gateway/period";

test("parseBudgetDurationMs understands common periods", () => {
  assert.equal(parseBudgetDurationMs(""), null);
  assert.equal(parseBudgetDurationMs("monthly"), 30 * 86_400_000);
  assert.equal(parseBudgetDurationMs("7d"), 7 * 86_400_000);
  assert.equal(parseBudgetDurationMs("bogus"), null);
});

test("periodElapsed is false until the window passes", () => {
  const created = new Date("2026-01-01T00:00:00.000Z");
  const before = new Date("2026-01-15T00:00:00.000Z");
  const after = new Date("2026-02-02T00:00:00.000Z");
  assert.equal(periodElapsed("30d", null, before, created), false);
  assert.equal(periodElapsed("30d", null, after, created), true);
  assert.equal(periodElapsed("", null, after, created), false);
});

test("capExceeded treats 0 as unlimited", () => {
  assert.equal(capExceeded(100, 0), false);
  assert.equal(capExceeded(10, 10), true);
  assert.equal(capExceeded(9, 10, 0), false);
  assert.equal(capExceeded(15, 10, 10), false);
  assert.equal(capExceeded(20, 10, 10), true);
});
