import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test, { afterEach, beforeEach } from "node:test";
import { alertWebhooksSchema } from "@/schemas/settings";

const db = {
  enterprise: {} as Record<string, unknown>,
  audit: [] as { action: string; afterJson: string }[],
};

(globalThis as { prisma?: unknown }).prisma = {
  setting: {
    findUnique: async ({ where }: { where: { key: string } }) =>
      where.key === "enterprise" ? { key: where.key, value: JSON.stringify(db.enterprise) } : null,
  },
  gatewayAuditLog: {
    create: async ({ data }: { data: (typeof db.audit)[number] }) => {
      db.audit.push(data);
      return data;
    },
  },
};
delete process.env.REDIS_URL;

const realFetch = globalThis.fetch;
let calls: { url: string; headers: Record<string, string>; body: string }[] = [];

beforeEach(() => {
  db.enterprise = {};
  db.audit = [];
  calls = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
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

test("normalizeEnterprise migrates the single legacy webhook to every event", async () => {
  const { normalizeEnterprise } = await import("@/lib/gateway/settings");
  const ent = normalizeEnterprise({
    alert_webhook: " https://hooks.example.test/legacy ",
    alert_webhook_secret: "whsec",
  });
  assert.deepEqual(ent.alert_webhooks, [
    {
      id: "legacy",
      url: "https://hooks.example.test/legacy",
      secret: "whsec",
      events: ["upstream_exhaustion", "budget_threshold", "provider_models_changed"],
    },
  ]);
  assert.deepEqual(normalizeEnterprise({}).alert_webhooks, []);
});

test("normalizeEnterprise keeps the webhook list and drops unknown events and broken entries", async () => {
  const { normalizeEnterprise } = await import("@/lib/gateway/settings");
  const ent = normalizeEnterprise({
    alert_webhook: "https://hooks.example.test/legacy",
    alert_webhooks: [
      { id: "a", url: "https://a.test", secret: "", events: ["budget_threshold", "nope", 3] },
      { id: "", url: "https://missing-id.test", events: ["budget_threshold"] },
      { id: "b", url: "  ", events: ["budget_threshold"] },
      "garbage",
    ],
  });
  assert.deepEqual(ent.alert_webhooks, [
    { id: "a", url: "https://a.test", secret: "", events: ["budget_threshold"] },
  ]);
});

test("alertWebhooksSchema requires an http(s) URL, at least one known event, and a bounded list", () => {
  const valid = {
    id: null,
    url: "https://hooks.example.test",
    secret: "",
    clearSecret: false,
    events: ["budget_threshold"],
  };
  assert.equal(alertWebhooksSchema.safeParse([valid]).success, true);
  assert.equal(alertWebhooksSchema.safeParse([{ ...valid, url: "" }]).success, false);
  assert.equal(alertWebhooksSchema.safeParse([{ ...valid, url: "ftp://hooks.example.test" }]).success, false);
  assert.equal(alertWebhooksSchema.safeParse([{ ...valid, events: [] }]).success, false);
  assert.equal(alertWebhooksSchema.safeParse([{ ...valid, events: ["unknown"] }]).success, false);
  assert.equal(alertWebhooksSchema.safeParse(Array.from({ length: 21 }, () => valid)).success, false);
});

test("fireAlert delivers only to webhooks subscribed to the event, each with its own signature", async () => {
  const { fireAlert } = await import("@/lib/gateway/alerts");
  db.enterprise = {
    alert_webhooks: [
      { id: "ops", url: "https://ops.test/hook", secret: "ops-secret", events: ["upstream_exhaustion"] },
      {
        id: "finance",
        url: "https://finance.test/hook",
        secret: "",
        events: ["budget_threshold", "upstream_exhaustion"],
      },
      { id: "models", url: "https://models.test/hook", secret: "m", events: ["provider_models_changed"] },
    ],
  };

  await fireAlert("upstream_exhaustion", "no healthy deployment");

  assert.deepEqual(calls.map((c) => c.url).sort(), ["https://finance.test/hook", "https://ops.test/hook"]);
  const ops = calls.find((c) => c.url === "https://ops.test/hook");
  const finance = calls.find((c) => c.url === "https://finance.test/hook");
  assert.ok(ops && finance);
  const expected = createHmac("sha256", "ops-secret")
    .update(`${ops.headers["X-LLMHub-Timestamp"]}.${ops.body}`)
    .digest("hex");
  assert.equal(ops.headers["X-LLMHub-Signature"], `sha256=${expected}`);
  assert.equal(finance.headers["X-LLMHub-Signature"], undefined);
  assert.equal(JSON.parse(ops.body).id, JSON.parse(finance.body).id);
  assert.equal(JSON.parse(ops.body).event, "upstream_exhaustion");

  const delivered = db.audit.filter((a) => a.action === "alert_delivered").map((a) => JSON.parse(a.afterJson).webhook);
  assert.deepEqual(delivered.sort(), ["finance", "ops"]);
});

test("fireAlert sends nothing when no webhook subscribes to the event", async () => {
  const { fireAlert } = await import("@/lib/gateway/alerts");
  db.enterprise = {
    alert_webhooks: [{ id: "ops", url: "https://ops.test/hook", secret: "", events: ["upstream_exhaustion"] }],
  };
  await fireAlert("budget_threshold", "team crossed 80%");
  assert.equal(calls.length, 0);
  assert.equal(db.audit.length, 0);
});

test("deliverWebhook skips a queued job whose webhook was removed or unsubscribed", async () => {
  const { deliverWebhook } = await import("@/lib/gateway/alerts");
  db.enterprise = {
    alert_webhooks: [{ id: "ops", url: "https://ops.test/hook", secret: "", events: ["upstream_exhaustion"] }],
  };
  await deliverWebhook({ id: "e1", webhookId: "gone", event: "upstream_exhaustion", message: "x" });
  await deliverWebhook({ id: "e2", webhookId: "ops", event: "budget_threshold", message: "x" });
  assert.equal(calls.length, 0);
});
