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
  assert.match(source, /await registerWorkerSchedules\(\)/);
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
