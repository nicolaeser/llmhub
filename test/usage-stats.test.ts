import assert from "node:assert/strict";
import test from "node:test";
import {
  chargebackRows,
  groupRequestHealth,
  groupSpend,
  percentileIndex,
} from "@/lib/gateway/usage-stats";
import type { UsageSlice } from "@/types/gateway";

const slice = (row: Partial<UsageSlice>): UsageSlice => ({
  day: "2026-10-05",
  keyId: "",
  teamId: "",
  orgId: "",
  projectId: "",
  userId: "",
  model: "",
  requests: 0,
  errors: 0,
  rateLimited: 0,
  latencyMs: 0,
  promptTokens: 0,
  completionTokens: 0,
  cost: 0,
  ...row,
});

const rows = [
  slice({ model: "a", teamId: "t1", orgId: "o1", keyId: "k1", userId: "u1", requests: 3, cost: 2, promptTokens: 10, completionTokens: 5, latencyMs: 30 }),
  slice({ model: "a", teamId: "t1", orgId: "o1", keyId: "k2", userId: "u1", requests: 1, cost: 3, promptTokens: 1, completionTokens: 1, latencyMs: 10 }),
  slice({ model: "b", teamId: "t2", requests: 2, errors: 2, rateLimited: 1, latencyMs: 40 }),
];

test("groupSpend rolls up billable slices by the chosen tenant key", () => {
  const byTeam = groupSpend(rows, "teamId");
  assert.equal(byTeam.length, 1);
  assert.equal(byTeam[0]?.name, "t1");
  assert.equal(byTeam[0]?.spend, 5);
  assert.equal(groupSpend(rows, "keyId").length, 2);
});

test("groupRequestHealth counts every request, errors, 429s, and mean latency", () => {
  const byModel = groupRequestHealth(rows, "model");
  const a = byModel.find((row) => row.name === "a");
  const b = byModel.find((row) => row.name === "b");
  assert.equal(a?.requests, 4);
  assert.equal(a?.latency, 10);
  assert.equal(b?.errors, 2);
  assert.equal(b?.rate429, 1);
});

test("chargeback rows keep the tenant path and skip non-billable slices", () => {
  const charge = chargebackRows(rows);
  assert.equal(charge.length, 2);
  assert.equal(charge[0]?.name, "o1/t1/-/k2/u1/a");
  assert.equal(charge.reduce((n, row) => n + row.spend, 0), 5);
});

test("percentileIndex picks the nearest-rank position", () => {
  assert.equal(percentileIndex(1, 95), 0);
  assert.equal(percentileIndex(4, 50), 1);
  assert.equal(percentileIndex(100, 95), 94);
});
