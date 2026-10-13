import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test, { afterEach, beforeEach } from "node:test";
import { Queue } from "bullmq";
import type { WebhookJobData } from "@/types/jobs";

type Row = Record<string, unknown>;
type Args = { where?: Row; data?: Row; select?: Row };
type Call = { model: string; method: string; args: Args };

const calls: Call[] = [];
let enterprise: Row = {};

function fakeModel(model: string) {
  return new Proxy(
    {},
    {
      get: (_target, method: string) => async (args: Args = {}) => {
        calls.push({ model, method, args });
        if (model === "setting" && method === "findUnique") {
          return args.where?.key === "enterprise" ? { key: "enterprise", value: JSON.stringify(enterprise) } : null;
        }
        if (model === "setting" && method === "create" && args.data?.key === "model_catalog_lock") {
          throw Object.assign(new Error("lock held by another replica"), { code: "P2002" });
        }
        if (method === "deleteMany" || method === "updateMany") return { count: 0 };
        if (method === "findMany" || method === "groupBy") return [];
        if (method === "count") return 0;
        if (method === "create" || method === "upsert") return { id: `${model}_1`, ...args.data };
        return null;
      },
    },
  );
}

const fakes = new Map<string, ReturnType<typeof fakeModel>>();

(globalThis as { prisma?: unknown }).prisma = new Proxy(
  {},
  {
    get: (_target, model: string) => {
      if (model.startsWith("$")) return async () => [];
      const fake = fakes.get(model) ?? fakeModel(model);
      fakes.set(model, fake);
      return fake;
    },
  },
);
process.env.REDIS_URL = "redis://127.0.0.1:9";
delete process.env.SMTP_URL;

const realFetch = globalThis.fetch;
let delivered: { url: string; headers: Record<string, string>; body: string }[] = [];

beforeEach(() => {
  calls.length = 0;
  enterprise = {};
  delivered = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    delivered.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ""),
    });
    return new Response("ok");
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const HOOK = { id: "ops", url: "https://hooks.example.test/ops", secret: "whsec-ops-signing", events: ["budget_threshold"] };

function audits(action: string): Row[] {
  return calls
    .filter((call) => call.model === "gatewayAuditLog" && call.method === "create" && call.args.data?.action === action)
    .map((call) => JSON.parse(String(call.args.data?.afterJson)));
}

test("the processors are the maintenance sweep, the model sync, and webhook delivery", async () => {
  const processors = await import("@/lib/jobs/processors");
  assert.deepEqual(Object.keys(processors).sort(), ["processMaintenance", "processModelSync", "processWebhook"]);
});

test("processMaintenance runs the sweep, which runs budget alerts once", async () => {
  const { processMaintenance } = await import("@/lib/jobs/processors");
  await processMaintenance();
  for (const model of ["session", "passwordResetToken", "loginAttempt", "tempBudget"]) {
    assert.ok(calls.some((call) => call.model === model && call.method === "deleteMany"), model);
  }
  const budgetPasses = calls.filter(
    (call) => call.model === "project" && call.method === "findMany" && call.args.select?.alias,
  );
  assert.equal(budgetPasses.length, 1);
});

test("processModelSync runs the catalog sync behind its lock", async () => {
  const { processModelSync } = await import("@/lib/jobs/processors");
  await processModelSync();
  const settings = calls.filter((call) => call.model === "setting");
  assert.deepEqual(settings.slice(0, 2).map((call) => [call.method, call.args.where?.key ?? call.args.data?.key]), [
    ["findUnique", "model_catalog_state"],
    ["create", "model_catalog_lock"],
  ]);
  assert.equal(calls.some((call) => call.model === "providerConnection"), false);
});

test("processWebhook delivers the queued alert and counts BullMQ attempts", async () => {
  const { processWebhook } = await import("@/lib/jobs/processors");
  enterprise = { alert_webhooks: [HOOK] };
  const data: WebhookJobData = { id: "alert_1", webhookId: "ops", event: "budget_threshold", message: "team crossed 80%" };
  await processWebhook({ data, attemptsMade: 2 } as Parameters<typeof processWebhook>[0]);
  assert.deepEqual(delivered.map((call) => call.url), [HOOK.url]);
  assert.deepEqual(audits("alert_delivered").map((after) => [after.webhook, after.attempts]), [["ops", 3]]);
});

test("consumers attach BullMQ workers for the maintenance, models, and webhooks queues", async (t) => {
  t.mock.method(console, "error", () => {});
  const { buildQueueWorkers } = await import("@/worker/consumers");
  const { QUEUE_NAMES } = await import("@/lib/jobs/queues");
  const workers = buildQueueWorkers();
  try {
    assert.deepEqual(
      workers.map((worker) => worker.name),
      [QUEUE_NAMES.maintenance, QUEUE_NAMES.models, QUEUE_NAMES.webhooks],
    );
  } finally {
    await Promise.all(workers.map((worker) => worker.close(true)));
  }
});

test("schedules upsert exactly the maintenance and model sync schedulers", async (t) => {
  t.mock.method(console, "error", () => {});
  const schedulers: unknown[][] = [];
  const added: unknown[][] = [];
  t.mock.method(Queue.prototype, "upsertJobScheduler", async function (this: Queue, ...args: unknown[]) {
    schedulers.push([this.name, ...args]);
    return undefined;
  });
  t.mock.method(Queue.prototype, "add", async function (this: Queue, ...args: unknown[]) {
    added.push([this.name, ...args]);
    return undefined;
  });
  const { registerWorkerSchedules } = await import("@/worker/schedules");
  const { QUEUE_NAMES, closeQueues } = await import("@/lib/jobs/queues");
  try {
    await registerWorkerSchedules();
    assert.deepEqual(schedulers, [
      [QUEUE_NAMES.maintenance, QUEUE_NAMES.maintenance, { every: 60_000 }, { name: QUEUE_NAMES.maintenance, data: {} }],
      [QUEUE_NAMES.models, QUEUE_NAMES.models, { every: 7_200_000 }, { name: QUEUE_NAMES.models, data: {} }],
    ]);
    assert.deepEqual(added.map((call) => call.slice(0, 2)), [[QUEUE_NAMES.models, QUEUE_NAMES.models]]);
  } finally {
    await closeQueues();
  }
});

test("fireAlert enqueues signed webhooks without secrets when jobs are enabled", async (t) => {
  t.mock.method(console, "error", () => {});
  const jobs: { queue: string; name: string; data: WebhookJobData }[] = [];
  t.mock.method(Queue.prototype, "add", async function (this: Queue, name: string, data: WebhookJobData) {
    jobs.push({ queue: this.name, name, data });
    return undefined;
  });
  const { deliverWebhook, fireAlert } = await import("@/lib/alerts/notify");
  const { QUEUE_NAMES, closeQueues } = await import("@/lib/jobs/queues");
  enterprise = { alert_webhooks: [HOOK] };
  try {
    await fireAlert("budget_threshold", "team crossed 80%");
    assert.equal(delivered.length, 0);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].queue, QUEUE_NAMES.webhooks);
    assert.deepEqual(Object.keys(jobs[0].data).sort(), ["event", "id", "message", "webhookId"]);
    assert.equal(JSON.stringify(jobs[0]).includes(HOOK.secret), false);
    assert.equal(JSON.stringify(jobs[0]).includes(HOOK.url), false);

    await deliverWebhook(jobs[0].data);
    assert.equal(delivered.length, 1);
    const { headers, body } = delivered[0];
    const signature = createHmac("sha256", HOOK.secret).update(`${headers["X-LLMHub-Timestamp"]}.${body}`).digest("hex");
    assert.equal(headers["X-LLMHub-Signature"], `sha256=${signature}`);
    assert.equal(Object.keys(headers).some((name) => name.toLowerCase() === "authorization"), false);
    assert.equal(JSON.stringify(headers).includes(HOOK.secret), false);
    assert.equal(body.includes(HOOK.secret), false);
  } finally {
    await closeQueues();
  }
});
