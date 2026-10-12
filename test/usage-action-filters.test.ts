import assert from "node:assert/strict";
import test from "node:test";
import type { AuthenticatedSession, Permission } from "@/types/auth";

type Call = { model: string; method: string; args: { where?: Record<string, unknown> } };

const calls: Call[] = [];

const usageRows = [
  {
    day: new Date("2026-10-10T00:00:00.000Z"),
    orgId: "o1",
    teamId: "t1",
    projectId: "p1",
    memberId: "m1",
    keyId: "k1",
    userId: "u1",
    model: "model-a",
    requests: 10,
    errors: 2,
    rateLimited: 1,
    latencyMs: 4000,
    promptTokens: 100,
    completionTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 3,
    cacheSavings: 0,
    purchaseCost: 2,
  },
  {
    day: new Date("2026-10-11T00:00:00.000Z"),
    orgId: "o2",
    teamId: "t2",
    projectId: "",
    memberId: "",
    keyId: "k2",
    userId: "u2",
    model: "model-b",
    requests: 5,
    errors: 0,
    rateLimited: 3,
    latencyMs: 1000,
    promptTokens: 40,
    completionTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 1,
    cacheSavings: 0,
    purchaseCost: 0.5,
  },
];

const lookups: Record<string, unknown[]> = {
  "usageDaily.findMany": usageRows,
  "organization.findMany": [{ id: "o1", alias: "Acme" }, { id: "o2", alias: "Globex" }],
  "team.findMany": [{ id: "t1", alias: "Research" }],
  "project.findMany": [{ id: "p1", alias: "Search" }],
  "member.findMany": [{ id: "m1", name: "Ada" }],
  "virtualKey.findMany": [{ id: "k1", keyAlias: "", prefix: "sk-hub-k1" }],
  "user.findMany": [{ id: "u1", username: "ops" }],
};

(globalThis as { prisma?: unknown }).prisma = new Proxy(
  {},
  {
    get: (_target, model: string) =>
      new Proxy(
        {},
        {
          get: (_inner, method: string) => async (args: Call["args"]) => {
            calls.push({ model, method, args });
            if (model === "requestLog" && method === "count") return 20;
            if (model === "requestLog" && method === "findFirst") return { latencyMs: 900 };
            return lookups[`${model}.${method}`] ?? [];
          },
        },
      ),
  },
);

function principal(permissions: Permission[], orgId: string | null = null): AuthenticatedSession {
  return {
    error: false,
    sessionId: "s1",
    user: { id: "u-self", username: "analyst", email: "analyst@example.com", orgId } as AuthenticatedSession["user"],
    isOwner: false,
    role: null,
    permissions,
    secondFactor: "TOTP",
    ipAddress: null,
    userAgent: null,
  };
}

async function loadAs(session: AuthenticatedSession, input: Parameters<typeof import("@/lib/usage/dashboard").loadUsage>[0]) {
  const { runAsPrincipal } = await import("@/lib/auth/delegation");
  const { loadUsage } = await import("@/lib/usage/dashboard");
  calls.length = 0;
  const usage = await runAsPrincipal(session, () => loadUsage(input));
  const whereOf = (model: string, method: string, window: string) => {
    const call = calls.find((row) => row.model === model && row.method === method);
    assert.ok(call, `${model}.${method}`);
    const { [window]: range, ...filters } = call.args.where ?? {};
    assert.ok((range as { gte?: unknown }).gte instanceof Date, window);
    return filters;
  };
  return {
    usage,
    usageWhere: whereOf("usageDaily", "findMany", "day"),
    latencyWhere: whereOf("requestLog", "count", "createdAt"),
  };
}

test("loadUsage narrows the usage and latency queries to every tenant filter and drops blank ones", async () => {
  const reader = principal(["spend:read", "spend:read-all"]);
  const { usageWhere, latencyWhere, usage } = await loadAs(reader, {
    days: 7,
    model: "model-a",
    teamId: " t1 ",
    orgId: "o1",
    projectId: "p1",
    memberId: "m1",
    keyId: "k1",
    userId: "u9",
  });
  const filters = { model: "model-a", teamId: "t1", orgId: "o1", projectId: "p1", memberId: "m1", keyId: "k1", userId: "u9" };
  assert.deepEqual(usageWhere, filters);
  assert.deepEqual(latencyWhere, filters);
  assert.equal(usage.teamId, "t1");

  const blank = await loadAs(reader, { teamId: "  ", keyId: "" });
  assert.deepEqual(blank.usageWhere, {});
});

test("loadUsage applies the caller's spend scope over the requested filters", async () => {
  const scoped = principal(["spend:read"], "o-own");
  const { usageWhere, latencyWhere } = await loadAs(scoped, { orgId: "o-other", userId: "u-other", teamId: "t1" });
  assert.deepEqual(usageWhere, { teamId: "t1", orgId: "o-own", userId: "u-self" });
  assert.deepEqual(latencyWhere, { teamId: "t1", orgId: "o-own", userId: "u-self" });
});

test("loadUsage returns tenant rollups, request health, chargeback rows, names, p95 latency, and 429s", async () => {
  const { usage } = await loadAs(principal(["spend:read", "spend:read-all"]), 14);
  const names = (rows: { name: string }[]) => rows.map((row) => row.name);
  assert.deepEqual(names(usage.byTeam), ["t1", "t2"]);
  assert.deepEqual(names(usage.byOrg), ["o1", "o2"]);
  assert.deepEqual(names(usage.byProject), ["p1", "unassigned"]);
  assert.deepEqual(names(usage.byMember), ["m1", "unassigned"]);
  assert.deepEqual(names(usage.byKey), ["k1", "k2"]);
  assert.deepEqual(names(usage.byUser), ["u1", "u2"]);
  assert.deepEqual(
    usage.healthByModel.map((row) => [row.name, row.requests, row.errors, row.rate429]),
    [
      ["model-a", 10, 2, 1],
      ["model-b", 5, 0, 3],
    ],
  );
  assert.deepEqual(names(usage.healthByTeam), ["t1", "t2"]);
  assert.deepEqual(
    usage.chargeback.map((row) => [row.name, row.spend]),
    [
      ["o1/t1/p1/m1/k1/u1/model-a", 3],
      ["o2/t2/-/-/k2/u2/model-b", 1],
    ],
  );
  assert.deepEqual(usage.names, {
    o1: "Acme",
    o2: "Globex",
    t1: "Research",
    p1: "Search",
    m1: "Ada",
    k1: "sk-hub-k1",
    u1: "ops",
  });
  assert.equal(usage.p95Latency, 900);
  assert.equal(usage.rate429, 4);
});
