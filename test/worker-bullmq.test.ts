import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { QUEUE_NAMES } from "@/lib/jobs/queues";

const root = fileURLToPath(new URL("..", import.meta.url));

function file(relativePath: string) {
  return readFile(path.join(root, relativePath), "utf8");
}

test("bootWorker uses jobsEnabled, BullMQ workers, schedules, and mode fallbacks", async () => {
  const source = await file("src/worker/boot.ts");

  assert.match(source, /from "@\/lib\/jobs\/connection"/);
  assert.match(source, /if \(jobsEnabled\(\)\)/);
  assert.match(source, /const \{ buildQueueWorkers \} = await import\("\.\/consumers"\)/);
  assert.match(
    source,
    /const \{ registerWorkerSchedules \} = await import\("\.\/schedules"\)/,
  );
  assert.match(source, /buildQueueWorkers\(\)/);
  assert.match(source, /await withRedisTimeout\(registerWorkerSchedules\(\)/);
  assert.match(source, /setWorkerMode\("bullmq"\)/);
  assert.match(source, /setWorkerMode\("local"\)/);
  assert.match(source, /setWorkerMode\("unavailable"\)/);
  assert.match(source, /worker\.bullmq_unavailable/);

  const bullmq = source.indexOf('setWorkerMode("bullmq")');
  const unavailable = source.indexOf('setWorkerMode("unavailable")');
  const local = source.indexOf('setWorkerMode("local")');
  assert.ok(bullmq >= 0 && unavailable > bullmq && local > unavailable);

  assert.match(source, /function startLocalTimer/);
  assert.match(source, /setInterval\(tick, WORKER_TICK_MS\)/);
  assert.equal(source.match(/startLocalTimer\(g\)/g)?.length, 2);
  assert.match(
    source,
    /setWorkerMode\("unavailable"\)[\s\S]*?startLocalTimer\(g\)/,
  );
  assert.match(source, /setWorkerMode\("local"\)[\s\S]*?startLocalTimer\(g\)/);
});

test("a worker that booted without Redis keeps retrying BullMQ and stops its timers once it switches", async () => {
  const source = await file("src/worker/boot.ts");
  const fallback = source.slice(source.indexOf('setWorkerMode("unavailable")'));
  assert.match(fallback, /^setWorkerMode\("unavailable"\);\s*startLocalTimer\(g\);\s*retryQueueWorkers\(1\);/);

  const retry = source.slice(source.indexOf("const retryQueueWorkers"), source.indexOf("if (jobsEnabled())"));
  assert.match(retry, /setTimeout\(/);
  assert.match(retry, /timer\.unref\(\)/);
  assert.match(retry, /startQueueWorkers\(g\)/);
  assert.match(retry, /stopLocalTimers\(g\);\s*setWorkerMode\("bullmq"\);\s*logger\.info\("worker\.mode_changed"/);
  assert.match(retry, /retryQueueWorkers\(attempt \+ 1\)/);

  const start = source.slice(source.indexOf("async function startQueueWorkers"));
  assert.ok(start.indexOf("assertRedisReachable()") < start.indexOf("buildQueueWorkers()"));
  assert.match(start, /withRedisTimeout\(registerWorkerSchedules\(\), BULLMQ_START_TIMEOUT_MS\)/);

  const shutdown = source.slice(source.indexOf("const shutdown"));
  assert.match(shutdown, /clearTimeout\(g\.__llmhubBullmqRetry\)/);
});

test("BullMQ retries back off exponentially up to five minutes", async () => {
  const { bullmqRetryDelay } = await import("@/worker/boot");
  assert.deepEqual([1, 2, 3, 4].map(bullmqRetryDelay), [5_000, 10_000, 20_000, 40_000]);
  assert.equal(bullmqRetryDelay(7), 300_000);
  assert.equal(bullmqRetryDelay(1_000), 300_000);
  assert.equal(bullmqRetryDelay(0), 5_000);
});

test("the local maintenance sweep runs only while this replica holds the lease", async () => {
  const [boot, lease] = await Promise.all([file("src/worker/boot.ts"), file("src/lib/jobs/lease.ts")]);
  assert.match(boot, /MAINTENANCE_LEASE_MS = 55_000/);
  const sweep = boot.slice(boot.indexOf("async function leasedMaintenanceSweep"));
  assert.ok(sweep.indexOf("claimLease(MAINTENANCE_LEASE, MAINTENANCE_LEASE_MS)") < sweep.indexOf("runMaintenanceSweep()"));
  assert.match(boot, /const tick = \(\) =>\s*leasedMaintenanceSweep\(\)/);
  assert.match(lease, /prisma\.setting\.create/);
  assert.match(lease, /isPrismaCode\(error, "P2002"\)/);
  assert.doesNotMatch(lease, /\$queryRaw|\$executeRaw/);
});

test("QUEUE_NAMES include maintenance, models, and webhooks only", async () => {
  const source = await file("src/lib/jobs/queues.ts");
  assert.match(source, /maintenance: "llmhub-maintenance"/);
  assert.doesNotMatch(source, /llmhub-alerts/);
  assert.match(source, /models: "llmhub-models"/);
  assert.match(source, /webhooks: "llmhub-webhooks"/);
  assert.equal(QUEUE_NAMES.maintenance, "llmhub-maintenance");
  assert.deepEqual(Object.keys(QUEUE_NAMES).sort(), ["maintenance", "models", "webhooks"]);
  assert.equal(QUEUE_NAMES.models, "llmhub-models");
  assert.equal(QUEUE_NAMES.webhooks, "llmhub-webhooks");
});
