import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import * as Sentry from "@sentry/node";
import { DelayedError, type Job } from "bullmq";
import { QUEUE_NAMES } from "@/lib/jobs/queues";
import { sentryInitOptions } from "@/lib/sentry/options";
import { reportWorkerJobFailure, workerJobIds, wrapWorkerProcessor } from "@/lib/sentry/worker-jobs";
import { runSweepJob } from "@/worker/jobs";
import type { WebhookJobData } from "@/types/jobs";

const events: Sentry.ErrorEvent[] = [];
const client = Sentry.init({
  ...sentryInitOptions({ SENTRY_DSN: "https://key@sentry.invalid/1" }),
  transport: () => ({
    send: async (envelope: unknown) => {
      const [, items] = envelope as [unknown, Array<[{ type: string }, unknown]>];
      for (const [header, payload] of items) {
        if (header.type === "event") events.push(payload as Sentry.ErrorEvent);
      }
      return {};
    },
    flush: async () => true,
  }),
  defaultIntegrations: false,
});

after(() => client?.close());

async function captured(): Promise<Sentry.ErrorEvent[]> {
  await Sentry.flush(2_000);
  return events.splice(0);
}

const source = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

function webhookJob(attemptsMade: number): Job<WebhookJobData> {
  return {
    id: "alert_1-hook_1",
    attemptsMade,
    opts: { attempts: 8 },
    data: { id: "alert_1", webhookId: "hook_1", event: "budget_threshold", message: "Budget of owner@example.com at 90%" },
  } as unknown as Job<WebhookJobData>;
}

test("worker job Sentry context only copies bounded identifiers", () => {
  assert.deepEqual(
    workerJobIds({
      id: "alert_1",
      webhookId: "hook_1",
      event: "budget_threshold",
      message: "Budget of owner@example.com at 90%",
      payload: { token: "secret" },
    }),
    { id: "alert_1", webhookId: "hook_1" },
  );
  assert.deepEqual(workerJobIds({ task: "provider", providerId: "prov_1" }), { task: "provider", providerId: "prov_1" });
  assert.deepEqual(workerJobIds(null), {});
  assert.deepEqual(workerJobIds({ webhookId: 12 }), {});
});

test("every consumer wraps jobs for Sentry, which the server initializes once", async () => {
  const [instrumentation, consumers, boot, jobs] = await Promise.all([
    source("src/instrumentation.ts"),
    source("src/worker/consumers.ts"),
    source("src/worker/boot.ts"),
    source("src/worker/jobs.ts"),
  ]);
  assert.match(instrumentation, /import\("\.\/sentry\.server\.config"\)/);
  for (const queue of Object.keys(QUEUE_NAMES)) {
    assert.match(consumers, new RegExp(`wrapWorkerProcessor<\\w+>\\(QUEUE_NAMES\\.${queue},`), queue);
  }
  for (const file of [consumers, boot, jobs]) {
    assert.doesNotMatch(file, /Sentry\.init/);
  }
});

test("a failed attempt is reported with queue, job, and attempt tags but never the payload", async () => {
  const processor = wrapWorkerProcessor<WebhookJobData>(QUEUE_NAMES.webhooks, async () => {
    throw new Error("HTTP 500");
  });
  await assert.rejects(processor(webhookJob(2)), /HTTP 500/);
  await assert.rejects(processor(webhookJob(7)), /HTTP 500/);
  const [retry, final] = await captured();
  assert.equal(retry.tags?.["llmhub.surface"], "worker");
  assert.equal(retry.tags?.["llmhub.queue"], "llmhub-webhooks");
  assert.equal(retry.tags?.["llmhub.job_id"], "alert_1-hook_1");
  assert.equal(retry.tags?.["llmhub.alert_id"], "alert_1");
  assert.equal(retry.tags?.["llmhub.webhook_id"], "hook_1");
  assert.equal(retry.tags?.["llmhub.final_attempt"], "false");
  assert.equal(retry.extra?.["llmhub.attempts_made"], 2);
  assert.equal(final.tags?.["llmhub.final_attempt"], "true");
  assert.deepEqual(final.fingerprint, ["worker", "llmhub-webhooks", "job", "Error"]);
  assert.equal(JSON.stringify([retry, final]).includes("owner@example.com"), false);
});

test("a job moved back to delayed is not a failure", async () => {
  const processor = wrapWorkerProcessor<WebhookJobData>(QUEUE_NAMES.models, async () => {
    throw new DelayedError();
  });
  await assert.rejects(processor(webhookJob(0)), DelayedError);
  assert.deepEqual(await captured(), []);
});

test("a failed maintenance step is reported with its name and the sweep goes on", async (t) => {
  const logged = t.mock.method(console, "error", () => undefined);
  assert.equal(
    await runSweepJob("usage_reports", async () => {
      throw new Error("report failed");
    }),
    0,
  );
  reportWorkerJobFailure("plain value", { queue: QUEUE_NAMES.models, finalAttempt: true });
  const [step, model] = await captured();
  assert.match(String(logged.mock.calls[0]?.arguments[0]), /"event":"worker\.job_failed","job":"usage_reports"/);
  assert.equal(step.tags?.["llmhub.queue"], "llmhub-maintenance");
  assert.equal(step.tags?.["llmhub.step"], "usage_reports");
  assert.equal(step.tags?.["llmhub.final_attempt"], "true");
  assert.deepEqual(step.fingerprint, ["worker", "llmhub-maintenance", "usage_reports", "Error"]);
  assert.equal(model.exception?.values?.[0]?.value, "plain value");
});
