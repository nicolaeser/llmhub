import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { digest } from "@/lib/crypto";
import { GateError } from "@/lib/gateway/errors";
import { capExceeded } from "@/lib/gateway/billing/period";
import type { Principal } from "@/types/gateway";
import type { Deployment } from "@/types/routing";

type Row = Record<string, unknown>;
type Args = { where?: Row; data?: Row; select?: Row };
type Call = { model: string; method: string; args: Args; count?: number };

const HOLDER_TABLES = ["virtualKey", "user", "member", "project", "team", "organization"] as const;
const DAY_MS = 86_400_000;

const calls: Call[] = [];
const tables = new Map<string, Map<string, Row>>();
const staleReads = new Map<string, Row>();
const tempBudgets: Row[] = [];

function table(model: string): Map<string, Row> {
  const rows = tables.get(model) ?? new Map<string, Row>();
  tables.set(model, rows);
  return rows;
}

function sameValue(stored: unknown, wanted: unknown): boolean {
  if (stored instanceof Date || wanted instanceof Date) {
    return stored instanceof Date && wanted instanceof Date && stored.getTime() === wanted.getTime();
  }
  return (stored ?? null) === (wanted ?? null);
}

function isIncrement(value: unknown): value is { increment: number } {
  return typeof value === "object" && value !== null && "increment" in value;
}

function applyData(row: Row, data: Row): void {
  for (const [field, value] of Object.entries(data)) {
    row[field] = isIncrement(value) ? Number(row[field] ?? 0) + value.increment : value;
  }
}

function fakeModel(model: string) {
  const record = (method: string, args: Args) => calls.push({ model, method, args });
  return {
    findUnique: async (args: Args) => {
      record("findUnique", args);
      const id = String(args.where?.id ?? args.where?.alias);
      const row = staleReads.get(`${model}:${id}`) ?? table(model).get(id);
      return row ? { ...row } : null;
    },
    findFirst: async (args: Args) => {
      record("findFirst", args);
      const hash = (args.where?.OR as Row[] | undefined)?.[0]?.hash;
      const row = [...table(model).values()].find((candidate) => candidate.hash === hash);
      return row ? { ...row } : null;
    },
    findMany: async (args: Args) => {
      record("findMany", args);
      if (model !== "tempBudget") return [];
      return tempBudgets.filter(
        (boost) => boost.entityType === args.where?.entityType && boost.entityId === args.where?.entityId,
      );
    },
    updateMany: async (args: Args) => {
      const where = Object.entries(args.where ?? {});
      const matched = [...table(model).values()].filter((row) => where.every(([field, value]) => sameValue(row[field], value)));
      for (const row of matched) applyData(row, args.data ?? {});
      calls.push({ model, method: "updateMany", args, count: matched.length });
      return { count: matched.length };
    },
    upsert: async (args: Args) => {
      record("upsert", args);
      return {};
    },
    create: async (args: Args) => {
      record("create", args);
      return { id: `${model}_1`, createdAt: new Date(), ...args.data };
    },
    count: async (args: Args) => {
      record("count", args);
      return 0;
    },
  };
}

const fakes = new Map<string, ReturnType<typeof fakeModel>>();

(globalThis as { prisma?: unknown }).prisma = new Proxy(
  {},
  {
    get: (_target, model: string) => {
      if (model === "$transaction") return (ops: Promise<unknown>[]) => Promise.all(ops);
      const fake = fakes.get(model) ?? fakeModel(model);
      fakes.set(model, fake);
      return fake;
    },
  },
);
delete process.env.REDIS_URL;

beforeEach(async () => {
  calls.length = 0;
  tables.clear();
  staleReads.clear();
  tempBudgets.length = 0;
  const { resetRateLimitMemory } = await import("@/lib/rate-limit/shared");
  resetRateLimitMemory();
});

function holder(model: string, id: string, over: Row = {}): Row {
  const row = {
    id,
    spend: 0,
    maxBudget: 0,
    budgetDuration: "",
    spendResetAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    blocked: false,
    ...over,
  };
  table(model).set(id, row);
  return row;
}

function token(id: string): string {
  return `sk-test-${id}`;
}

function keyRow(id: string, over: Row = {}): Row {
  const row = {
    id,
    hash: digest(token(id)),
    prefix: `sk-${id}`,
    keyAlias: id,
    userId: null,
    teamId: null,
    orgId: null,
    projectId: null,
    memberId: null,
    models: [],
    maxBudget: 0,
    spend: 0,
    rpmLimit: 0,
    tpmLimit: 0,
    maxRequestCost: 0,
    budgetDuration: "",
    spendResetAt: null,
    expiresAt: null,
    allowedIps: [],
    allowedEndpoints: [],
    accessWindows: [],
    accessTimeZone: "UTC",
    blocked: false,
    piiPolicy: null,
    guardrailPolicy: null,
    logContent: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    templates: [],
    ...over,
  };
  table("virtualKey").set(id, row);
  return row;
}

function chainPrincipal(): Principal {
  return {
    actor: "sk-k",
    key: { token_id: "k", project_id: "p", member_id: "stale_member", max_request_cost: 0 } as Principal["key"],
    userId: "u",
    memberId: "m",
    teamId: "t",
    orgId: "o",
    models: [],
    routeLimits: {},
  };
}

const CHAIN = [
  ["key", "virtualKey", "k"],
  ["user", "user", "u"],
  ["member", "member", "m"],
  ["project", "project", "p"],
  ["team", "team", "t"],
  ["org", "organization", "o"],
] as const;

const deployment: Deployment = {
  id: "dep_1",
  kind: "openai",
  base_url: "https://upstream.example.invalid/v1",
  model: "gpt-4o",
  weight: 1,
  cost_input_per_1k: 1,
  cost_output_per_1k: 2,
  provider_id: "",
};

function rejectsWith(status: number, code: string, message?: string) {
  return (err: unknown) => {
    assert.ok(err instanceof GateError, String(err));
    assert.equal(err.status, status);
    assert.equal(err.code, code);
    if (message !== undefined) assert.equal(err.message, message);
    return true;
  };
}

function charged(model: string): Call[] {
  return calls.filter((call) => call.model === model && call.method === "updateMany");
}

test("capExceeded treats 0 as unlimited and extra as headroom", () => {
  assert.equal(capExceeded(100, 0), false);
  assert.equal(capExceeded(12, 10, 5), false);
  assert.equal(capExceeded(15, 10, 5), true);
});

test("assertBudget checks the whole chain: key, user, member, project, team, and org", async () => {
  const { assertBudget } = await import("@/lib/gateway/billing/billing");
  for (const [kind, model, id] of CHAIN) {
    for (const [, other, otherId] of CHAIN) holder(other, otherId, { spend: 10, maxBudget: 100 });
    table(model).get(id)!.spend = 100;
    await assert.rejects(assertBudget(chainPrincipal()), rejectsWith(429, "budget_exceeded", `${kind} budget exceeded`));
  }

  for (const [, model, id] of CHAIN) holder(model, id, { spend: 10, maxBudget: 100 });
  holder("member", "m", { spend: 15, maxBudget: 20 });
  holder("member", "stale_member", { spend: 50, maxBudget: 20 });
  calls.length = 0;
  assert.deepEqual(await assertBudget(chainPrincipal()), { limit: 5, budget: "member" });
  assert.deepEqual(new Set(calls.map((call) => call.model)), new Set([...HOLDER_TABLES, "tempBudget"]));

  holder("member", "m", { spend: 25, maxBudget: 20 });
  tempBudgets.push({ entityType: "member", entityId: "m", amount: 12 });
  assert.deepEqual(await assertBudget(chainPrincipal()), { limit: 7, budget: "member" });
});

test("recordUsage charges the user and member budgets alongside key, team, org, and project", async () => {
  const { recordUsage } = await import("@/lib/gateway/billing/billing");
  for (const [, model, id] of CHAIN) holder(model, id, { spend: 1 });
  const cost = await recordUsage({
    principal: chainPrincipal(),
    model: "api/gpt",
    deployment,
    usage: { prompt_tokens: 1000, completion_tokens: 1000 },
    status: 200,
    outcome: "ok",
    latencyMs: 10,
  });
  assert.equal(cost, 3);

  for (const [, model, id] of CHAIN) {
    assert.deepEqual(
      charged(model).map((call) => call.args),
      [{ where: { id }, data: { spend: { increment: cost } } }],
      model,
    );
    assert.equal(table(model).get(id)!.spend, 4, model);
  }
  const usage = calls.find((call) => call.model === "usageDaily" && call.method === "upsert");
  const now = new Date();
  assert.deepEqual(usage?.args.where, {
    slice: {
      day: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
      keyId: "k",
      teamId: "t",
      orgId: "o",
      projectId: "p",
      memberId: "m",
      userId: "u",
      model: "gpt",
    },
  });

  calls.length = 0;
  await recordUsage({ principal: chainPrincipal(), model: "gpt", status: 500, outcome: "error", latencyMs: 1 });
  for (const model of HOLDER_TABLES) assert.deepEqual(charged(model), [], model);
});

test("period resets only win once under concurrency", async () => {
  const { assertBudget } = await import("@/lib/gateway/billing/billing");
  const user: Principal = { actor: "u", userId: "u", memberId: "", teamId: "", orgId: "", models: [], routeLimits: {} };
  const staleReset = new Date(Date.now() - 2 * DAY_MS);
  const otherReset = new Date(Date.now() - 1_000);

  holder("user", "u", { spend: 3, maxBudget: 100, budgetDuration: "1d", spendResetAt: otherReset });
  staleReads.set("user:u", { ...table("user").get("u"), spend: 90, spendResetAt: staleReset });
  assert.deepEqual(await assertBudget(user), { limit: 100, budget: "user" });
  assert.deepEqual(
    charged("user").map((call) => call.args.where),
    [{ id: "u", spendResetAt: staleReset }],
  );
  assert.equal(table("user").get("u")!.spend, 3);
  assert.equal(table("user").get("u")!.spendResetAt, otherReset);

  staleReads.clear();
  calls.length = 0;
  holder("user", "u", { spend: 90, maxBudget: 100, budgetDuration: "1d", spendResetAt: staleReset });
  await Promise.all([assertBudget(user), assertBudget(user), assertBudget(user)]);
  const won = charged("user").filter((call) => call.count === 1);
  assert.equal(won.length, 1);
  assert.equal(table("user").get("u")!.spend, 0);
  assert.equal(table("user").get("u")!.spendResetAt, won[0].args.data?.spendResetAt);
});

test("key principals resolve tenancy live and reject inactive owners", async () => {
  const { authenticateBearer, keyPrincipal } = await import("@/lib/gateway/access/principal");
  holder("member", "m1", { orgId: "org_live", teamId: "team_live" });
  holder("project", "p1", { orgId: "org_p", teamId: "team_p" });
  holder("user", "owner", { orgId: "org_owner" });
  holder("user", "orgless", { orgId: null });
  keyRow("member_key", { memberId: "m1", userId: "console_user", teamId: "stale_team", orgId: "stale_org" });
  keyRow("project_key", { projectId: "p1", userId: "console_user", teamId: "stale_team", orgId: "stale_org" });
  keyRow("owner_key", { userId: "owner", teamId: "stale_team", orgId: "stale_org" });
  keyRow("orgless_key", { userId: "orgless", orgId: "stale_org" });
  keyRow("ownerless_key", { orgId: "stale_org" });

  const tenancy = (p: Principal) => ({ userId: p.userId, memberId: p.memberId, teamId: p.teamId, orgId: p.orgId });
  assert.deepEqual(tenancy(await authenticateBearer(token("member_key"))), {
    userId: "",
    memberId: "m1",
    teamId: "team_live",
    orgId: "org_live",
  });
  assert.deepEqual(tenancy(await authenticateBearer(token("project_key"))), {
    userId: "",
    memberId: "",
    teamId: "team_p",
    orgId: "org_p",
  });
  const project = await authenticateBearer(token("project_key"));
  assert.equal(project.key?.project_id, "p1");
  assert.deepEqual(tenancy(await authenticateBearer(token("owner_key"))), {
    userId: "owner",
    memberId: "",
    teamId: "",
    orgId: "org_owner",
  });
  assert.deepEqual(tenancy(await authenticateBearer(token("orgless_key"))), {
    userId: "orgless",
    memberId: "",
    teamId: "",
    orgId: "",
  });

  table("member").get("m1")!.teamId = "team_moved";
  assert.equal((await keyPrincipal("member_key"))?.teamId, "team_moved");

  const inactive = rejectsWith(401, "invalid_api_key", "api key owner is not active");
  await assert.rejects(authenticateBearer(token("ownerless_key")), inactive);
  table("member").get("m1")!.blocked = true;
  table("user").get("owner")!.blocked = true;
  table("project").delete("p1");
  for (const id of ["member_key", "project_key", "owner_key"]) {
    await assert.rejects(authenticateBearer(token(id)), inactive, id);
    assert.equal(await keyPrincipal(id), null, id);
  }
  await assert.rejects(authenticateBearer(token("unknown_key")), rejectsWith(401, "invalid_api_key", "invalid api key"));
});

test("customer keys are never billed to the console user who created them", async () => {
  const { authenticateBearer } = await import("@/lib/gateway/access/principal");
  const { assertBudget, recordUsage } = await import("@/lib/gateway/billing/billing");
  holder("user", "console_user", { spend: 500, maxBudget: 10 });
  holder("member", "m1", { orgId: "org_live", teamId: "" });
  holder("project", "p1", { orgId: "org_p", teamId: "" });
  keyRow("member_key", { memberId: "m1", userId: "console_user" });
  keyRow("project_key", { projectId: "p1", userId: "console_user" });

  for (const id of ["member_key", "project_key"]) {
    const principal = await authenticateBearer(token(id));
    assert.equal(principal.userId, "", id);
    assert.equal(await assertBudget(principal), null, id);
    calls.length = 0;
    await recordUsage({
      principal,
      model: "gpt",
      deployment,
      usage: { prompt_tokens: 1000, completion_tokens: 0 },
      status: 200,
      outcome: "ok",
      latencyMs: 1,
    });
    assert.deepEqual(charged("user"), [], id);
    assert.ok(charged("virtualKey").length, id);
    const spend = calls.find((call) => call.model === "spendEvent");
    assert.equal(spend?.args.data?.userId, "", id);
  }
  assert.equal(table("user").get("console_user")!.spend, 500);
});

test("gateRequest admits through budgets, rate limits, and the request cost cap", async () => {
  const { gateRequest } = await import("@/lib/gateway/access/gate");
  const { incrementRateWindow } = await import("@/lib/rate-limit/shared");
  holder("user", "owner", { orgId: null });
  keyRow("gate_key", { userId: "owner", rpmLimit: 2, maxBudget: 10, spend: 4 });
  const request = (headers: Record<string, string> = {}) =>
    new Request("http://hub.local/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${token("gate_key")}`, ...headers },
    });

  const capped = await gateRequest(request({ "x-hub-max-cost": "0.5" }));
  assert.deepEqual(capped.trace?.costCap, { limit: 0.5, budget: null });
  const budgeted = await gateRequest(request());
  assert.deepEqual(budgeted.trace?.costCap, { limit: 6, budget: "key" });
  await assert.rejects(gateRequest(request()), rejectsWith(429, "rate_limit_exceeded", "rpm exceeded"));
  await assert.rejects(gateRequest(request({ "x-hub-max-cost": "-1" })), rejectsWith(400, "invalid_request"));

  table("virtualKey").get("gate_key")!.spend = 10;
  const before = (await incrementRateWindow("gate_key", 0, 0)).rpm;
  await assert.rejects(gateRequest(request()), rejectsWith(429, "budget_exceeded", "key budget exceeded"));
  assert.equal((await incrementRateWindow("gate_key", 0, 0)).rpm, before);
});

test("admit gives session callers their user budget as the cost cap and counts their requests", async () => {
  const { admit, withTrace } = await import("@/lib/gateway/access/gate");
  const { sessionPrincipal } = await import("@/lib/gateway/access/principal");
  const { incrementRateWindow } = await import("@/lib/rate-limit/shared");
  holder("user", "console", { spend: 2, maxBudget: 5 });
  holder("organization", "org_c", { spend: 0, maxBudget: 50 });
  const principal = withTrace(sessionPrincipal({ id: "console", orgId: "org_c" }), "/internal-api/playground/chat");
  await admit(principal);
  assert.deepEqual(principal.trace?.costCap, { limit: 3, budget: "user" });
  assert.equal((await incrementRateWindow("console", 0, 0)).rpm, 1);
  table("user").get("console")!.spend = 5;
  await assert.rejects(admit(principal), rejectsWith(429, "budget_exceeded", "user budget exceeded"));
});
