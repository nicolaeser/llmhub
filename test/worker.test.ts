import assert from "node:assert/strict";
import net from "node:net";
import { fileURLToPath } from "node:url";
import test, { mock } from "node:test";
import { retentionCutoff } from "@/worker/retention";
import type { GlobalWithWorkerBoot } from "@/types/jobs";

type Call = { model: string; method: string; args: { where?: { key?: string }; data?: { key?: string } } };

delete process.env.REDIS_URL;

const calls: Call[] = [];
let releaseCatalog = () => {};
const catalogGate = new Promise<void>((resolve) => {
  releaseCatalog = resolve;
});

function fakeModel(model: string) {
  return new Proxy(
    {},
    {
      get: (_target, method: string) => async (args: Call["args"]) => {
        calls.push({ model, method, args });
        if (model === "setting" && method === "findUnique" && args.where?.key === "role_templates_seeded") {
          await catalogGate;
        }
        if (method === "deleteMany" || method === "updateMany") return { count: 0 };
        if (method === "findMany" || method === "groupBy") return [];
        if (method === "count") return 0;
        if (method === "create" || method === "upsert") return { id: `${model}-1`, ...args.data };
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

const upstream: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  upstream.push(String(input));
  return new Response("unavailable", { status: 503 });
}) as typeof fetch;

const logLines: string[] = [];
mock.method(console, "log", (line: string) => logLines.push(line));
mock.method(console, "error", (line: string) => logLines.push(line));
const socketConnects = mock.method(net.Socket.prototype, "connect");

const g = globalThis as GlobalWithWorkerBoot;
const sourcePath = (relativePath: string) => fileURLToPath(new URL(relativePath, import.meta.url));
const isLeaseClaim = (call: Call) =>
  call.model === "setting" && call.method === "create" && call.args.data?.key === "maintenance_sweep_lock";
const isCatalogWrite = (call: Call) => call.model === "role" || (call.model === "setting" && call.method === "upsert");

async function until(condition: () => boolean) {
  const deadline = performance.now() + 10_000;
  while (!condition() && performance.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(condition());
}

function setPhase(runtime: string | undefined, phase: string | undefined) {
  if (runtime === undefined) delete process.env.NEXT_RUNTIME;
  else process.env.NEXT_RUNTIME = runtime;
  if (phase === undefined) delete process.env.NEXT_PHASE;
  else process.env.NEXT_PHASE = phase;
}

test("log retention cutoff is null when disabled", () => {
  const now = new Date("2026-09-07T12:00:00.000Z");
  assert.equal(retentionCutoff(0, now), null);
  assert.equal(retentionCutoff(-1, now), null);
  assert.equal(
    retentionCutoff(14, now)?.toISOString(),
    "2026-08-24T12:00:00.000Z",
  );
});

test("instrumentation loads nothing outside the Node.js server runtime or during the production build", async () => {
  const { register } = await import("@/instrumentation");
  const instrumentation = require.cache[sourcePath("../src/instrumentation.ts")];
  assert.ok(instrumentation);
  assert.deepEqual(instrumentation.children, []);
  for (const [runtime, phase] of [
    [undefined, undefined],
    ["edge", undefined],
    ["nodejs", "phase-production-build"],
  ] as const) {
    setPhase(runtime, phase);
    await register();
  }
  assert.deepEqual(instrumentation.children, []);
  assert.deepEqual(calls, []);
  assert.equal(g.__llmhubWorkerBoot, undefined);
});

test("instrumentation seeds the system catalog before it starts the worker", async () => {
  const { register } = await import("@/instrumentation");
  const exit = mock.method(process, "exit", () => undefined);
  setPhase("nodejs", undefined);
  const registering = register();
  await until(() => calls.length > 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(g.__llmhubWorkerBoot, undefined);
  assert.equal(calls.some(isLeaseClaim), false);

  releaseCatalog();
  await registering;
  assert.ok(g.__llmhubWorkerBoot);
  await until(() => calls.some(isLeaseClaim));
  const lastCatalogWrite = calls.findLastIndex(isCatalogWrite);
  assert.ok(lastCatalogWrite >= 0);
  assert.ok(calls.findIndex(isLeaseClaim) > lastCatalogWrite);
  assert.equal(exit.mock.callCount(), 0);
  exit.mock.restore();
});

test("a worker without Redis runs local timers, loads no BullMQ consumers, and never contacts Redis", async () => {
  const { getWorkerMode } = await import("@/worker/health");
  assert.equal(getWorkerMode(), "local");
  assert.equal(g.__llmhubWorkerTimer?.hasRef(), false);
  assert.equal(g.__llmhubModelSyncTimer?.hasRef(), false);
  assert.equal(g.__llmhubBullmqRetry, undefined);
  assert.equal(g.__llmhubQueueWorkers, undefined);
  for (const lazy of ["../src/worker/consumers.ts", "../src/worker/schedules.ts"]) {
    assert.equal(require.cache[sourcePath(lazy)], undefined, lazy);
  }
  const started = logLines.map((line) => JSON.parse(line)).find((entry) => entry.event === "worker.started");
  assert.equal(started?.mode, "local");
  assert.equal(started?.intervalMs, 60_000);
  assert.equal(socketConnects.mock.callCount(), 0);
  assert.deepEqual(upstream, []);
});
