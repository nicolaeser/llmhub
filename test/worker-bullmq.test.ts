import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import test, { after, mock } from "node:test";
import { fileURLToPath } from "node:url";
import { QUEUE_NAMES } from "@/lib/jobs/queues";
import type { GlobalWithWorkerBoot } from "@/types/jobs";

process.env.REDIS_URL = "redis://127.0.0.1:1";

type Call = { model: string; method: string; args: { where?: { key?: string }; data?: { key?: string; value?: string } } };

const root = fileURLToPath(new URL("..", import.meta.url));
const calls: Call[] = [];
let leaseHeldElsewhere = true;
let leaseExpired = false;

function fakeModel(model: string) {
  return new Proxy(
    {},
    {
      get: (_target, method: string) => async (args: Call["args"]) => {
        calls.push({ model, method, args });
        if (model === "setting" && method === "create" && leaseHeldElsewhere) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        if (model === "setting" && method === "deleteMany" && leaseExpired) {
          leaseExpired = false;
          leaseHeldElsewhere = false;
          return { count: 1 };
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
    get: (_target, name: string) => {
      if (name.startsWith("$")) {
        return async () => {
          calls.push({ model: name, method: name, args: {} });
          return [];
        };
      }
      return fakeModel(name);
    },
  },
);

const sharedRedis = globalThis as { __llmhubRedis?: Promise<unknown> };
sharedRedis.__llmhubRedis = Promise.resolve(null);

globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as typeof fetch;

const logLines: { level: string; event: string; [key: string]: unknown }[] = [];
const capture = (line: string) => {
  logLines.push(JSON.parse(line));
};
mock.method(console, "log", capture);
mock.method(console, "error", capture);
mock.method(console, "warn", capture);
const socketConnects = mock.method(net.Socket.prototype, "connect");
mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
after(() => mock.timers.reset());
const timerProbe = setTimeout(() => {}, 1);
const mockedTimer: { unref(): unknown } = Object.getPrototypeOf(timerProbe);
const unrefs = mock.method(mockedTimer, "unref");
clearTimeout(timerProbe);
const unrefed = (timer: unknown) => unrefs.mock.calls.some((call) => call.this === timer);

const g = globalThis as GlobalWithWorkerBoot;
const bootAt = Date.now();
let workerShutdown: (() => void) | undefined;

function file(relativePath: string) {
  return readFile(path.join(root, relativePath), "utf8");
}

async function flush(condition: () => boolean = () => true) {
  const deadline = performance.now() + 10_000;
  while (!condition() && performance.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(condition());
}

const bullmqUnavailable = () => logLines.filter((line) => line.event === "worker.bullmq_unavailable");
const leaseClaims = () =>
  calls.filter((call) => call.model === "setting" && call.method === "create" && call.args.data?.key === "maintenance_sweep_lock");
const sweeps = () => calls.filter((call) => call.model === "passwordResetToken" && call.method === "deleteMany");

test("a worker with Redis configured but unreachable falls back to local timers without building BullMQ workers", async () => {
  const { startWorker } = await import("@/worker/boot");
  const { getWorkerMode } = await import("@/worker/health");
  const listeners = new Set(process.listeners("SIGTERM"));
  assert.equal(startWorker(), undefined);
  await flush(() => g.__llmhubBullmqRetry !== undefined);
  workerShutdown = process.listeners("SIGTERM").find((listener) => !listeners.has(listener)) as () => void;

  assert.equal(getWorkerMode(), "unavailable");
  assert.ok(g.__llmhubWorkerTimer);
  assert.ok(g.__llmhubModelSyncTimer);
  for (const timer of [g.__llmhubWorkerTimer, g.__llmhubModelSyncTimer, g.__llmhubBullmqRetry]) {
    assert.equal(unrefed(timer), true);
  }
  assert.equal(g.__llmhubQueueWorkers, undefined);
  for (const lazy of ["src/worker/consumers.ts", "src/worker/schedules.ts"]) {
    assert.equal(require.cache[path.join(root, lazy)], undefined, lazy);
  }
  assert.deepEqual(
    bullmqUnavailable().map(({ err, attempt, retryInMs }) => ({ err, attempt, retryInMs })),
    [{ err: "Redis is unreachable", attempt: 0, retryInMs: 5_000 }],
  );
  assert.equal(socketConnects.mock.callCount(), 0);
});

test("a worker that booted without Redis keeps retrying BullMQ with backoff and keeps its local timers", async () => {
  const { getWorkerMode } = await import("@/worker/health");
  const localTimer = g.__llmhubWorkerTimer;
  mock.timers.tick(4_999);
  await flush();
  assert.equal(bullmqUnavailable().length, 1);
  mock.timers.tick(1);
  await flush(() => bullmqUnavailable().length === 2);
  mock.timers.tick(10_000);
  await flush(() => bullmqUnavailable().length === 3);
  assert.deepEqual(
    bullmqUnavailable().map(({ attempt, retryInMs }) => [attempt, retryInMs]),
    [
      [0, 5_000],
      [1, 10_000],
      [2, 20_000],
    ],
  );
  assert.equal(getWorkerMode(), "unavailable");
  assert.equal(g.__llmhubWorkerTimer, localTimer);
  assert.equal(unrefed(g.__llmhubBullmqRetry), true);
  assert.equal(g.__llmhubQueueWorkers, undefined);
  assert.equal(socketConnects.mock.callCount(), 0);
});

test("BullMQ retries back off exponentially up to five minutes", async () => {
  const { bullmqRetryDelay } = await import("@/worker/boot");
  assert.deepEqual([1, 2, 3, 4].map(bullmqRetryDelay), [5_000, 10_000, 20_000, 40_000]);
  assert.equal(bullmqRetryDelay(7), 300_000);
  assert.equal(bullmqRetryDelay(1_000), 300_000);
  assert.equal(bullmqRetryDelay(0), 5_000);
});

test("the local maintenance sweep runs only while this replica holds the lease", async () => {
  assert.equal(leaseClaims()[0]?.args.data?.value, String(bootAt + 55_000));
  assert.deepEqual(sweeps(), []);
  assert.ok(calls.some((call) => call.model === "setting" && call.method === "deleteMany"));

  leaseHeldElsewhere = false;
  const claimsBefore = leaseClaims().length;
  mock.timers.tick(bootAt + 60_000 - Date.now());
  await flush(() => sweeps().length === 1);
  assert.equal(leaseClaims().length, claimsBefore + 1);
  assert.equal(leaseClaims().at(-1)?.args.data?.value, String(bootAt + 60_000 + 55_000));
});

test("claimLease takes a free or expired lease and yields to a live one", async () => {
  const { claimLease } = await import("@/lib/jobs/lease");
  calls.length = 0;
  leaseHeldElsewhere = false;
  assert.equal(await claimLease("probe_lock", 1_000, 5_000), true);
  assert.deepEqual(calls.map((call) => [call.model, call.method, call.args.data]), [
    ["setting", "create", { key: "probe_lock", value: "6000" }],
  ]);

  calls.length = 0;
  leaseHeldElsewhere = true;
  assert.equal(await claimLease("probe_lock", 1_000, 5_000), false);
  assert.deepEqual(
    calls.map((call) => `${call.model}.${call.method}`),
    ["setting.create", "setting.deleteMany"],
  );
  assert.deepEqual(calls[1]?.args.where, { key: "probe_lock", value: { lt: "5000" } });

  calls.length = 0;
  leaseExpired = true;
  assert.equal(await claimLease("probe_lock", 1_000, 5_000), true);
  assert.deepEqual(
    calls.map((call) => `${call.model}.${call.method}`),
    ["setting.create", "setting.deleteMany", "setting.create"],
  );
  assert.deepEqual(calls[2]?.args.data, { key: "probe_lock", value: "6000" });
  leaseHeldElsewhere = true;
});

test("shutdown cancels the pending BullMQ retry and the local timers", async () => {
  assert.ok(workerShutdown);
  const warnings = bullmqUnavailable().length;
  const claims = leaseClaims().length;
  workerShutdown();
  await flush(() => g.__llmhubBullmqRetry === undefined);
  assert.equal(g.__llmhubWorkerTimer, undefined);
  assert.equal(g.__llmhubModelSyncTimer, undefined);
  assert.ok(logLines.some((line) => line.event === "worker.shutdown" && line.signal === "SIGTERM"));
  mock.timers.tick(600_000);
  await flush();
  assert.equal(bullmqUnavailable().length, warnings);
  assert.equal(leaseClaims().length, claims);
});

test("starting the worker returns at once and never exits while Redis does not answer", async () => {
  const { startWorker } = await import("@/worker/boot");
  const { getWorkerMode } = await import("@/worker/health");
  const exit = mock.method(process, "exit", () => undefined);
  g.__llmhubWorkerBoot = undefined;
  sharedRedis.__llmhubRedis = new Promise(() => {});
  assert.equal(startWorker(), undefined);
  const boot = g.__llmhubWorkerBoot;
  assert.ok(boot);
  await flush();
  const pending = Symbol("pending");
  assert.equal(await Promise.race([boot, Promise.resolve(pending)]), pending);
  assert.notEqual(getWorkerMode(), "bullmq");
  assert.equal(exit.mock.callCount(), 0);
  exit.mock.restore();
});

test("switching to BullMQ needs a live Redis, so the switch order is pinned in source", async () => {
  const boot = await file("src/worker/boot.ts");
  assert.match(boot, /const queues = await startQueueWorkers\(g\);\s*setWorkerMode\("bullmq"\);/);
  assert.match(boot, /stopLocalTimers\(g\);\s*setWorkerMode\("bullmq"\);/);
  assert.match(boot, /await withRedisTimeout\(registerWorkerSchedules\(\), BULLMQ_START_TIMEOUT_MS\)/);
});

test("QUEUE_NAMES include maintenance, models, and webhooks only", async () => {
  assert.equal(QUEUE_NAMES.maintenance, "llmhub-maintenance");
  assert.deepEqual(Object.keys(QUEUE_NAMES).sort(), ["maintenance", "models", "webhooks"]);
  assert.equal(QUEUE_NAMES.models, "llmhub-models");
  assert.equal(QUEUE_NAMES.webhooks, "llmhub-webhooks");
});
