import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import test from "node:test";
import { retentionCutoff, shorterRetention } from "@/worker/retention";
import { RETENTION_LEASE, runRetention } from "@/worker/retention-sweep";
import type { RetentionStep, RetentionTable, RetentionTask } from "@/types/jobs";

let enterprise: Record<string, number> = {};
let leaseHeld = false;

recordedPrisma.base = {
  setting: {
    findUnique: (args: { where: { key: string } }) =>
      args.where.key === "enterprise" ? { key: "enterprise", value: JSON.stringify(enterprise) } : null,
    create: (args: { data: { key: string; value: string } }) => {
      if (leaseHeld && args.data.key === RETENTION_LEASE) {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }
      return args.data;
    },
  },
};

globalThis.fetch = (async () => {
  throw new Error("the sweep must not call out");
}) as typeof fetch;

const now = new Date("2026-09-09T00:00:00.000Z");

function daysBefore(days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

const RETENTION_QUERIES: Record<string, { method: string; field: string }> = {
  requestLog: { method: "findMany", field: "createdAt" },
  requestLogContent: { method: "findMany", field: "createdAt" },
  spendEvent: { method: "findMany", field: "createdAt" },
  gatewayAuditLog: { method: "findMany", field: "createdAt" },
  userSecurityEvent: { method: "findMany", field: "createdAt" },
  toolExecution: { method: "findMany", field: "startedAt" },
  approvalRequest: { method: "findMany", field: "decidedAt" },
  usageDaily: { method: "findFirst", field: "day" },
};

async function sweepCutoffs(settings: Record<string, number>) {
  const { runMaintenanceSweep } = await import("@/worker/jobs");
  enterprise = settings;
  recordedPrisma.reset();
  await runMaintenanceSweep(now);
  return Object.fromEntries(
    Object.entries(RETENTION_QUERIES).map(([model, { method, field }]) => {
      const reads = recordedPrisma
        .called(model, method)
        .filter((call) => Boolean((call.args as { orderBy?: Record<string, string> }).orderBy?.[field]));
      assert.ok(reads.length <= 1, model);
      const where = (reads[0]?.args as { where?: Record<string, { lt?: Date }> } | undefined)?.where;
      return [model, where?.[field]?.lt?.toISOString() ?? null];
    }),
  );
}

test("request log retention is independent of spend and audit", async () => {
  const kept = { content_retention_days: 0, security_retention_days: 0 };
  const seven = await sweepCutoffs({ ...kept, log_retention_days: 7, spend_retention_days: 0, audit_retention_days: 0 });
  assert.deepEqual(
    { requestLog: seven.requestLog, spendEvent: seven.spendEvent, gatewayAuditLog: seven.gatewayAuditLog },
    { requestLog: daysBefore(7), spendEvent: null, gatewayAuditLog: null },
  );
  const finance = await sweepCutoffs({ ...kept, log_retention_days: 0, spend_retention_days: 30, audit_retention_days: 90 });
  assert.deepEqual(
    { requestLog: finance.requestLog, spendEvent: finance.spendEvent, gatewayAuditLog: finance.gatewayAuditLog },
    { requestLog: null, spendEvent: daysBefore(30), gatewayAuditLog: daysBefore(90) },
  );
});

test("unset retention removes request logs and content after 30 days and security activity after 90", async () => {
  assert.deepEqual(await sweepCutoffs({}), {
    requestLog: daysBefore(30),
    requestLogContent: daysBefore(30),
    spendEvent: null,
    gatewayAuditLog: null,
    userSecurityEvent: daysBefore(90),
    toolExecution: daysBefore(30),
    approvalRequest: null,
    usageDaily: null,
  });
});

test("an explicit 0 keeps every table and explicit days are used as set", async () => {
  const forever = {
    log_retention_days: 0,
    content_retention_days: 0,
    spend_retention_days: 0,
    usage_retention_days: 0,
    audit_retention_days: 0,
    security_retention_days: 0,
  };
  assert.deepEqual(Object.values(await sweepCutoffs(forever)), Array(8).fill(null));
  const cutoffs = await sweepCutoffs({
    log_retention_days: 365,
    content_retention_days: 14,
    spend_retention_days: 400,
    usage_retention_days: 730,
    audit_retention_days: 180,
    security_retention_days: 60,
  });
  assert.deepEqual(cutoffs, {
    requestLog: daysBefore(365),
    requestLogContent: daysBefore(14),
    spendEvent: daysBefore(400),
    gatewayAuditLog: daysBefore(180),
    userSecurityEvent: daysBefore(60),
    toolExecution: daysBefore(14),
    approvalRequest: daysBefore(180),
    usageDaily: "2024-09-09T00:00:00.000Z",
  });
  const [rejected] = recordedPrisma.called("approvalRequest", "findMany");
  assert.equal((rejected?.args as { where: { status: string } }).where.status, "rejected");
});

test("a sweep that finds the retention lease taken deletes nothing", async () => {
  leaseHeld = true;
  try {
    assert.deepEqual(Object.values(await sweepCutoffs({})), Array(8).fill(null));
  } finally {
    leaseHeld = false;
  }
});

test("retentionCutoff still disables at 0 and the shorter set retention wins", () => {
  assert.equal(retentionCutoff(0, now), null);
  assert.equal(shorterRetention(0, 0), 0);
  assert.equal(shorterRetention(30, 0), 30);
  assert.equal(shorterRetention(30, 7), 7);
});

function backlogTask(name: RetentionTable, rows: number, log: string[]): RetentionTask & { left: () => number } {
  let left = rows;
  return {
    name,
    left: () => left,
    step: async (take): Promise<RetentionStep> => {
      log.push(name);
      const deleted = Math.min(take, left);
      left -= deleted;
      return { deleted, more: deleted === take };
    },
  };
}

test("runRetention deletes in chunks, takes turns between tables, and stops at the time budget", async () => {
  const log: string[] = [];
  let clock = 0;
  const logs = backlogTask("requestLogs", 10, log);
  const events = backlogTask("securityEvents", 3, log);
  const run = await runRetention([logs, events], {
    chunk: 2,
    budgetMs: 6,
    clock: () => clock++,
  });
  assert.deepEqual(log, ["requestLogs", "securityEvents", "requestLogs"]);
  assert.deepEqual(run.deleted, { requestLogs: 4, securityEvents: 2 });
  assert.deepEqual(run.backlog, ["requestLogs", "securityEvents"]);

  log.length = 0;
  clock = 0;
  const rest = await runRetention([logs, events], { chunk: 2, budgetMs: 1_000, clock: () => clock++ });
  assert.deepEqual(rest.deleted, { requestLogs: 6, securityEvents: 1 });
  assert.deepEqual(rest.backlog, []);
  assert.equal(logs.left() + events.left(), 0);
  assert.deepEqual(log, ["requestLogs", "securityEvents", "requestLogs", "requestLogs", "requestLogs"]);
});

test("runRetention keeps cleaning other tables when one fails", async () => {
  const log: string[] = [];
  const failing: RetentionTask = {
    name: "toolExecutions",
    step: async () => {
      log.push("toolExecutions");
      throw new Error("boom");
    },
  };
  const content = backlogTask("requestContents", 5, log);
  const run = await runRetention([failing, content], { chunk: 2 });
  assert.deepEqual(run.deleted, { requestContents: 5 });
  assert.deepEqual(run.backlog, []);
  assert.equal(log.filter((name) => name === "toolExecutions").length, 1);
});
