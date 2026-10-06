import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("processors call the sweep, model sync, and webhook delivery", async () => {
  const source = await readFile(
    path.join(root, "src/lib/jobs/processors.ts"),
    "utf8",
  );
  assert.match(source, /runMaintenanceSweep/);
  assert.match(source, /runModelSync/);
  assert.doesNotMatch(source, /runBudgetAlerts/);
  assert.match(source, /deliverWebhook/);
});

test("consumers attach BullMQ workers for maintenance, models, and webhooks", async () => {
  const source = await readFile(
    path.join(root, "src/worker/consumers.ts"),
    "utf8",
  );
  assert.match(source, /QUEUE_NAMES\.maintenance/);
  assert.match(source, /QUEUE_NAMES\.models/);
  assert.doesNotMatch(source, /QUEUE_NAMES\.alerts/);
  assert.match(source, /QUEUE_NAMES\.webhooks/);
  assert.match(source, /new Worker/);
});

test("schedules upsert the maintenance and model sync schedulers", async () => {
  const source = await readFile(
    path.join(root, "src/worker/schedules.ts"),
    "utf8",
  );
  assert.equal(source.match(/upsertJobScheduler/g)?.length, 2);
  assert.match(source, /MAINTENANCE_INTERVAL_MS/);
  assert.match(source, /MODEL_SYNC_INTERVAL_MS/);
  assert.doesNotMatch(source, /ALERTS_INTERVAL_MS/);
});

test("fireAlert enqueues without secrets when Redis is set", async () => {
  const source = await readFile(
    path.join(root, "src/lib/gateway/alerts.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /alertDelivery/);
  assert.match(source, /enqueueWebhook/);
  assert.match(source, /jobsEnabled/);
  assert.match(source, /X-LLMHub-Signature/);
  assert.doesNotMatch(source, /Authorization/);
});
