import assert from "node:assert/strict";
import test from "node:test";
import { retentionCutoff } from "@/worker/retention";

type Call = { model: string; method: string; args: unknown };

const calls: Call[] = [];
let enterprise: Record<string, number> = {};

function fakeModel(model: string) {
  return new Proxy(
    {},
    {
      get: (_target, method: string) => async (args: { where?: { key?: string } }) => {
        calls.push({ model, method, args });
        if (model === "setting" && method === "findUnique") {
          return args.where?.key === "enterprise" ? { key: "enterprise", value: JSON.stringify(enterprise) } : null;
        }
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

globalThis.fetch = (async () => {
  throw new Error("the sweep must not call out");
}) as typeof fetch;

const now = new Date("2026-09-09T00:00:00.000Z");

function daysBefore(days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

async function sweepCutoffs(settings: Record<string, number>) {
  const { runMaintenanceSweep } = await import("@/worker/jobs");
  enterprise = settings;
  calls.length = 0;
  await runMaintenanceSweep(now);
  const cutoff = (model: string) => {
    const deletes = calls.filter((call) => call.model === model && call.method === "deleteMany");
    assert.ok(deletes.length <= 1, model);
    const where = (deletes[0]?.args as { where?: { createdAt?: { lt?: Date } } } | undefined)?.where;
    return where?.createdAt?.lt?.toISOString() ?? null;
  };
  return { requestLog: cutoff("requestLog"), spendEvent: cutoff("spendEvent"), gatewayAuditLog: cutoff("gatewayAuditLog") };
}

test("request log retention is independent of spend and audit", async () => {
  assert.deepEqual(
    await sweepCutoffs({ log_retention_days: 7, spend_retention_days: 0, audit_retention_days: 0 }),
    { requestLog: daysBefore(7), spendEvent: null, gatewayAuditLog: null },
  );
  assert.deepEqual(
    await sweepCutoffs({ log_retention_days: 0, spend_retention_days: 30, audit_retention_days: 90 }),
    { requestLog: null, spendEvent: daysBefore(30), gatewayAuditLog: daysBefore(90) },
  );
  assert.deepEqual(
    await sweepCutoffs({ log_retention_days: 3, spend_retention_days: 400, audit_retention_days: 365 }),
    { requestLog: daysBefore(3), spendEvent: daysBefore(400), gatewayAuditLog: daysBefore(365) },
  );
});

test("retentionCutoff still disables at 0", () => {
  const now = new Date("2026-09-09T00:00:00.000Z");
  assert.equal(retentionCutoff(0, now), null);
});
