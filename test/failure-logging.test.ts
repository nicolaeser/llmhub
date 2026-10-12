import assert from "node:assert/strict";
import test from "node:test";
import type { Principal } from "@/types/gateway";

function unavailableError(): Error {
  return new Error("database unavailable\n    at the pool");
}

const pendingQuery = () => ({
  then: (_resolve: unknown, reject: (err: unknown) => void) => reject(unavailableError()),
});

const unavailable = new Proxy(
  {},
  {
    get: (_target, prop) =>
      typeof prop === "string" && prop.startsWith("$")
        ? async () => {
            throw unavailableError();
          }
        : new Proxy({}, { get: () => pendingQuery }),
  },
);

(globalThis as { prisma?: unknown }).prisma = unavailable;

const principal = {
  actor: "key:k1",
  key: { token_id: "k1", project_id: "" },
  teamId: "",
  orgId: "",
  userId: "u1",
  memberId: "",
  models: [],
  routeLimits: {},
} as unknown as Principal;

async function capture(run: () => Promise<unknown>): Promise<{ result: unknown; lines: Record<string, unknown>[] }> {
  const lines: Record<string, unknown>[] = [];
  const original = console.error;
  console.error = (line: unknown) => {
    lines.push(JSON.parse(String(line)) as Record<string, unknown>);
  };
  try {
    return { result: await run(), lines };
  } finally {
    console.error = original;
  }
}

test("recordUsageOrLog logs a failed billing write without request content and does not throw", async () => {
  const { recordUsageOrLog } = await import("@/lib/gateway/billing/billing");
  const { result, lines } = await capture(() =>
    recordUsageOrLog({
      principal,
      model: "gpt-house",
      status: 502,
      outcome: "error",
      latencyMs: 3,
      request: { messages: [{ role: "user", content: "secret prompt" }] },
      error: new Error("upstream down"),
    }),
  );
  assert.equal(result, undefined);
  assert.equal(lines.length, 1);
  assert.deepEqual(
    { ...lines[0], ts: undefined },
    {
      ts: undefined,
      level: "error",
      event: "billing.record_failed",
      model: "gpt-house",
      status: 502,
      outcome: "error",
      keyId: "k1",
      errName: "Error",
      err: "database unavailable",
    },
  );
  assert.doesNotMatch(JSON.stringify(lines), /secret prompt/);
});

test("meter.fail logs instead of dropping the failed request silently", async () => {
  const { meter } = await import("@/lib/gateway/billing/meter");
  const { lines } = await capture(() => meter(principal, "gpt-house", { input: "secret prompt" }).fail(new Error("boom")));
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.event, "billing.record_failed");
  assert.equal(lines[0]!.status, 502);
  assert.doesNotMatch(JSON.stringify(lines), /secret prompt/);
});

test("runSweepJob logs the failing job by name and returns 0", async () => {
  const { runSweepJob } = await import("@/worker/jobs");
  const { result, lines } = await capture(() =>
    runSweepJob("batches", async () => {
      throw new Error("queue offline");
    }),
  );
  assert.equal(result, 0);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.event, "worker.job_failed");
  assert.equal(lines[0]!.job, "batches");
  assert.equal(lines[0]!.err, "queue offline");
  assert.equal(await runSweepJob("reports", async () => 4), 4);
});

test("fireAlert logs when alert settings cannot be read", async () => {
  const { fireAlert } = await import("@/lib/alerts/notify");
  const { result, lines } = await capture(() => fireAlert("budget_threshold", "team crossed 80%"));
  assert.equal(result, undefined);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.event, "alert.fire_failed");
  assert.equal(lines[0]!.alertEvent, "budget_threshold");
  assert.doesNotMatch(JSON.stringify(lines), /team crossed/);
});
