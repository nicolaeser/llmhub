import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

type Row = Record<string, unknown>;
type Args = { where?: Row; data?: Row; select?: Row; create?: Row; update?: Row };
type Call = { model: string; method: string; args: Args };

const HOLDER_TABLES = ["virtualKey", "user", "member", "team", "organization", "project"] as const;
const DAY_MS = 86_400_000;
const NOW = new Date("2026-10-12T12:00:00Z");

const calls: Call[] = [];
const tables = new Map<string, Map<string, Row>>();
let failSpendResets = false;
let beforeUpdate: ((model: string, id: string) => void) | null = null;

function table(model: string): Map<string, Row> {
  const rows = tables.get(model) ?? new Map<string, Row>();
  tables.set(model, rows);
  return rows;
}

function fakeModel(model: string) {
  return new Proxy(
    {},
    {
      get: (_target, method: string) => async (args: Args = {}) => {
        calls.push({ model, method, args });
        if (method === "findMany") {
          if (failSpendResets && args.select?.budgetDuration) throw new Error("spend reset query failed");
          return [...table(model).values()].map((row) => ({ ...row }));
        }
        if (method === "updateMany" && args.where?.id !== undefined && args.data?.spend === 0) {
          const id = String(args.where.id);
          beforeUpdate?.(model, id);
          const row = table(model).get(id);
          const matches = row && Object.entries(args.where).every(([field, value]) => row[field] === value);
          if (matches) Object.assign(row, args.data);
          return { count: matches ? 1 : 0 };
        }
        if (method === "deleteMany" || method === "updateMany") return { count: 0 };
        if (method === "count") return 0;
        if (method === "groupBy") return [];
        if (method === "create" || method === "upsert") return {};
        return null;
      },
    },
  );
}

const fakes = new Map<string, ReturnType<typeof fakeModel>>();

(globalThis as { prisma?: unknown }).prisma = new Proxy(
  {},
  {
    get: (_target, model: string) => {
      if (model.startsWith("$")) return async () => [];
      const fake = fakes.get(model) ?? fakeModel(model);
      fakes.set(model, fake);
      return fake;
    },
  },
);
delete process.env.SMTP_URL;
delete process.env.REDIS_URL;

beforeEach(() => {
  calls.length = 0;
  tables.clear();
  failSpendResets = false;
  beforeUpdate = null;
});

function holder(model: string, id: string, over: Row = {}): Row {
  const row = {
    id,
    spend: 42,
    maxBudget: 0,
    budgetDuration: "",
    spendResetAt: null,
    createdAt: new Date(NOW.getTime() - 60 * DAY_MS),
    ...over,
  };
  table(model).set(id, row);
  return row;
}

function updates(model?: string): Call[] {
  return calls.filter(
    (call) => call.method === "updateMany" && call.args.data?.spend === 0 && (!model || call.model === model),
  );
}

test("runSpendResets zeroes spend on every budget holder whose period elapsed", async () => {
  const { runSpendResets } = await import("@/worker/jobs");
  const lastReset = new Date(NOW.getTime() - 2 * DAY_MS);
  for (const model of HOLDER_TABLES) {
    holder(model, `${model}_elapsed`, { budgetDuration: "1d", spendResetAt: lastReset });
    holder(model, `${model}_fresh`, { budgetDuration: "1d", spendResetAt: new Date(NOW.getTime() - 3_600_000) });
    holder(model, `${model}_never_reset`, { budgetDuration: "7d", createdAt: new Date(NOW.getTime() - 8 * DAY_MS) });
    holder(model, `${model}_young`, { budgetDuration: "7d", createdAt: new Date(NOW.getTime() - DAY_MS) });
    holder(model, `${model}_lifetime`, { budgetDuration: "" });
  }

  const pending = runSpendResets(NOW);
  assert.ok(pending instanceof Promise);
  assert.equal(await pending, HOLDER_TABLES.length * 2);

  for (const model of HOLDER_TABLES) {
    assert.deepEqual(
      updates(model).map((call) => call.args),
      [
        { where: { id: `${model}_elapsed`, spendResetAt: lastReset }, data: { spend: 0, spendResetAt: NOW } },
        { where: { id: `${model}_never_reset`, spendResetAt: null }, data: { spend: 0, spendResetAt: NOW } },
      ],
      model,
    );
    for (const id of ["fresh", "young", "lifetime"]) {
      assert.equal(table(model).get(`${model}_${id}`)!.spend, 42, `${model}_${id}`);
    }
  }
});

test("the spend reset sweep keeps a charge made after the gateway already reset the period", async () => {
  const { runSpendResets } = await import("@/worker/jobs");
  const elapsed = { budgetDuration: "1d", spendResetAt: new Date(NOW.getTime() - 2 * DAY_MS) };
  holder("user", "first", { ...elapsed, spend: 5 });
  holder("user", "racing", { ...elapsed, spend: 90 });
  const gatewayReset = new Date(NOW.getTime() + 1_000);
  beforeUpdate = (model, id) => {
    if (model === "user" && id === "first") Object.assign(table("user").get("racing")!, { spend: 3, spendResetAt: gatewayReset });
  };
  assert.equal(await runSpendResets(NOW), 1);
  assert.equal(table("user").get("first")!.spend, 0);
  assert.equal(table("user").get("racing")!.spend, 3);
  assert.equal(table("user").get("racing")!.spendResetAt, gatewayReset);
});

test("the maintenance sweep runs spend resets with its clock and survives their failure", async (t) => {
  const { runMaintenanceSweep } = await import("@/worker/jobs");
  const lastReset = new Date(NOW.getTime() - 2 * DAY_MS);
  holder("user", "user_elapsed", { budgetDuration: "1d", spendResetAt: lastReset });
  await runMaintenanceSweep(NOW);
  assert.deepEqual(
    updates().map((call) => [call.model, call.args]),
    [["user", { where: { id: "user_elapsed", spendResetAt: lastReset }, data: { spend: 0, spendResetAt: NOW } }]],
  );
  assert.equal(table("user").get("user_elapsed")!.spend, 0);

  holder("user", "user_elapsed", { budgetDuration: "1d", spendResetAt: new Date(NOW.getTime() - 2 * DAY_MS) });
  calls.length = 0;
  failSpendResets = true;
  const logged = t.mock.method(console, "error", () => {});
  await runMaintenanceSweep(NOW);
  assert.deepEqual(updates(), []);
  const failures = logged.mock.calls
    .map((call) => JSON.parse(String(call.arguments[0])))
    .filter((line) => line.event === "worker.job_failed" && line.job === "spend_resets");
  assert.deepEqual(failures.map((line) => line.err), ["spend reset query failed"]);
  assert.ok(calls.some((call) => call.model === "project" && call.method === "findMany" && call.args.select?.alias));
});

test("runBudgetAlerts includes projects", async () => {
  const { runBudgetAlerts } = await import("@/worker/jobs");
  holder("project", "proj_hot", { alias: "Checkout", spend: 85, maxBudget: 100 });
  holder("project", "proj_cold", { alias: "Search", spend: 10, maxBudget: 100 });

  assert.equal(await runBudgetAlerts(), 1);

  const audits = calls.filter((call) => call.model === "gatewayAuditLog" && call.method === "create");
  assert.deepEqual(
    audits.map((call) => [call.args.data?.objectType, call.args.data?.objectId, JSON.parse(String(call.args.data?.afterJson))]),
    [["project", "proj_hot", { threshold: 80, spend: 85, cap: 100 }]],
  );
  const state = calls.find((call) => call.model === "setting" && call.method === "upsert");
  assert.equal(state?.args.where?.key, "budget_alert_state");
  assert.deepEqual(JSON.parse(String(state?.args.create?.value)), { "project:proj_hot": "100:80" });
});
