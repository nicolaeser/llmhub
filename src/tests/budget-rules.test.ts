import assert from "node:assert/strict";
import test from "node:test";
import {
  budgetAmount,
  budgetPeriod,
  capConflict,
  headroom,
  MAX_BUDGET_AMOUNT,
  meterColor,
} from "@/lib/utils/budget";
import type { CapLink } from "@/types/structure";

function link(kind: CapLink["kind"], cap: number, spend = 0, boost = 0): CapLink {
  return { kind, id: kind, alias: kind, cap, spend, boost };
}

test("budgetPeriod normalizes known periods and rejects free text", () => {
  assert.equal(budgetPeriod(""), "");
  assert.equal(budgetPeriod(" Daily "), "1d");
  assert.equal(budgetPeriod("weekly"), "7d");
  assert.equal(budgetPeriod("monthly"), "30d");
  assert.equal(budgetPeriod("1mo"), "30d");
  assert.equal(budgetPeriod("14d"), "14d");
  assert.equal(budgetPeriod("0d"), null);
  assert.equal(budgetPeriod("400d"), null);
  assert.equal(budgetPeriod("forever"), null);
});

test("budgetAmount rounds to cents and rejects negative, huge, or non-numeric values", () => {
  assert.equal(budgetAmount(12.345), 12.35);
  assert.equal(budgetAmount("40"), 40);
  assert.equal(budgetAmount(0), 0);
  assert.equal(budgetAmount(-1), null);
  assert.equal(budgetAmount(Number.NaN), null);
  assert.equal(budgetAmount(MAX_BUDGET_AMOUNT + 1), null);
  assert.equal(budgetAmount("abc"), null);
});

test("capConflict blocks a child cap above any capped ancestor", () => {
  assert.equal(capConflict(0, [link("org", 10)]), null);
  assert.equal(capConflict(10, [link("org", 10)]), null);
  assert.equal(capConflict(50, [link("team", 0), link("org", 100)]), null);
  assert.equal(capConflict(150, [link("team", 0), link("org", 100)])?.kind, "org");
  assert.equal(capConflict(60, [link("team", 50), link("org", 100)])?.kind, "team");
});

test("headroom picks the tightest remaining budget in the chain", () => {
  assert.equal(headroom([link("key", 0), link("team", 0)]), null);
  const tight = headroom([link("team", 100, 90), link("org", 1000, 995)]);
  assert.equal(tight?.link.kind, "org");
  assert.equal(tight?.amount, 5);
  const boosted = headroom([link("team", 100, 100, 20), link("org", 0)]);
  assert.equal(boosted?.amount, 20);
  assert.equal(headroom([link("user", 10, 25)])?.amount, 0);
});

test("meterColor escalates near and at the cap", () => {
  assert.equal(meterColor(0.2), "accent");
  assert.equal(meterColor(0.8), "warning");
  assert.equal(meterColor(1), "danger");
});
