import assert from "node:assert/strict";
import test from "node:test";

type Call = { model: string; method: string; args: unknown };

const calls: Call[] = [];
let settingsFail = false;

function fakeModel(model: string) {
  return new Proxy(
    {},
    {
      get: (_target, method: string) => async (args: unknown) => {
        calls.push({ model, method, args });
        if (model === "setting" && settingsFail) throw new Error("settings unavailable");
        if (method === "deleteMany" || method === "updateMany") return { count: 0 };
        if (method === "findMany" || method === "groupBy") return [];
        if (method === "count") return 0;
        return null;
      },
    },
  );
}

(globalThis as { prisma?: unknown }).prisma = new Proxy(
  {},
  {
    get: (_target, model: string) => (model === "$transaction" ? async () => [] : fakeModel(model)),
  },
);

function generatedObjectPurges() {
  return calls.filter(
    (call) =>
      call.model === "storedObject" &&
      call.method === "findMany" &&
      JSON.stringify(call.args).includes('"response","video"'),
  );
}

test("the sweep purges generated objects with the configured retention", async () => {
  const { runMaintenanceSweep } = await import("@/worker/jobs");
  calls.length = 0;
  settingsFail = false;
  await runMaintenanceSweep(new Date("2026-10-12T12:00:00Z"));
  assert.equal(generatedObjectPurges().length, 1);
});

test("the sweep deletes no stored objects when settings cannot be loaded", async () => {
  const { runMaintenanceSweep } = await import("@/worker/jobs");
  calls.length = 0;
  settingsFail = true;
  await runMaintenanceSweep(new Date("2026-10-12T12:00:00Z"));
  assert.deepEqual(generatedObjectPurges(), []);
  for (const model of ["requestLog", "requestLogContent", "spendEvent", "gatewayAuditLog"]) {
    assert.equal(
      calls.some((call) => call.model === model && call.method === "deleteMany"),
      false,
      model,
    );
  }
});
