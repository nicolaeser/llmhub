import assert from "node:assert/strict";
import test from "node:test";
import {
  cacheHitRate,
  chargebackParts,
  chargebackRows,
  groupCache,
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
  memberId: "",
  userId: "",
  model: "",
  requests: 0,
  errors: 0,
  rateLimited: 0,
  latencyMs: 0,
  promptTokens: 0,
  completionTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
  cacheSavings: 0,
  ...row,
});

const rows = [
  slice({ model: "a", teamId: "t1", orgId: "o1", keyId: "k1", userId: "u1", requests: 3, cost: 2, promptTokens: 10, completionTokens: 5, latencyMs: 30 }),
  slice({ model: "a", teamId: "t1", orgId: "o1", memberId: "m1", keyId: "k2", requests: 1, cost: 3, promptTokens: 1, completionTokens: 1, latencyMs: 10 }),
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
  assert.equal(charge[0]?.name, "o1/t1/-/m1/k2/-/a");
  assert.equal(charge.reduce((n, row) => n + row.spend, 0), 5);
  assert.deepEqual(chargebackParts(charge[0]?.name ?? ""), {
    orgId: "o1",
    teamId: "t1",
    projectId: "",
    memberId: "m1",
    keyId: "k2",
    userId: "",
    model: "a",
  });
  assert.equal(groupSpend(rows, "memberId")[0]?.name, "m1");
});

test("groupCache keeps projects with cache activity and rates hits against all their prompt tokens", () => {
  const cached = [
    slice({ projectId: "p1", model: "a", promptTokens: 100, cacheReadTokens: 60, cacheWriteTokens: 10, cacheSavings: 0.5 }),
    slice({ projectId: "p1", model: "b", promptTokens: 100 }),
    slice({ projectId: "p2", promptTokens: 50, cacheWriteTokens: 50, cacheSavings: -0.1 }),
    slice({ projectId: "p3", promptTokens: 80 }),
  ];
  const byProject = groupCache(cached, "projectId");
  assert.deepEqual(
    byProject.map((row) => row.name),
    ["p1", "p2"],
  );
  assert.equal(byProject[0]?.prompt, 200);
  assert.equal(byProject[0]?.cacheRead, 60);
  assert.equal(byProject[0]?.cacheWrite, 10);
  assert.equal(byProject[1]?.cacheSavings, -0.1);
  assert.equal(cacheHitRate(byProject[0]?.cacheRead ?? 0, byProject[0]?.prompt ?? 0), 0.3);
  assert.equal(cacheHitRate(10, 0), 0);
});

test("percentileIndex picks the nearest-rank position", () => {
  assert.equal(percentileIndex(1, 95), 0);
  assert.equal(percentileIndex(4, 50), 1);
  assert.equal(percentileIndex(100, 95), 94);
});
