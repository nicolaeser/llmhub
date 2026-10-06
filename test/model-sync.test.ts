import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import type { DiscoveredModel } from "@/types/gateway";

const root = fileURLToPath(new URL("..", import.meta.url));

type FakeProvider = {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  apiKey: string;
  discovered: unknown;
  zdr: boolean;
  retentionDays: number | null;
  region: string;
  noTraining: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type FakeDeployment = { id: string; groupAlias: string; model: string; providerId: string };

const db = {
  providers: new Map<string, FakeProvider>(),
  deployments: [] as FakeDeployment[],
  audit: [] as { actor: string; action: string; objectId: string; afterJson: string }[],
  webhook: "",
};

const fakePrisma = {
  providerConnection: {
    findMany: async () => [...db.providers.values()],
    findUnique: async ({ where }: { where: { id: string } }) => db.providers.get(where.id) ?? null,
    update: async ({
      where,
      data,
    }: {
      where: { id: string; updatedAt?: Date };
      data: { discovered: unknown };
    }) => {
      const row = db.providers.get(where.id);
      if (!row || (where.updatedAt && row.updatedAt.getTime() !== where.updatedAt.getTime())) {
        throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
      }
      const next = { ...row, ...data, updatedAt: new Date(row.updatedAt.getTime() + 1_000) };
      db.providers.set(row.id, next);
      return next;
    },
  },
  deployment: {
    findMany: async ({ where }: { where: { providerId: string; model: { in: string[] } } }) =>
      db.deployments.filter(
        (d) => d.providerId === where.providerId && where.model.in.includes(d.model),
      ),
  },
  gatewayAuditLog: {
    create: async ({ data }: { data: (typeof db.audit)[number] }) => {
      db.audit.push(data);
      return data;
    },
  },
  setting: {
    findUnique: async ({ where }: { where: { key: string } }) =>
      where.key === "enterprise" && db.webhook
        ? { key: where.key, value: JSON.stringify({ alert_webhook: db.webhook }) }
        : null,
  },
  $transaction: async <T>(fn: (tx: object) => Promise<T>) => fn(fakePrisma),
};

(globalThis as { prisma?: unknown }).prisma = fakePrisma;
delete process.env.REDIS_URL;

const realFetch = globalThis.fetch;
let calls: { url: string; init?: RequestInit }[] = [];

function respondWith(handler: (url: string) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url);
  }) as typeof fetch;
}

function modelsResponse(ids: string[], price: Record<string, string> = {}) {
  return Response.json({
    data: ids.map((id) => ({
      id,
      name: id,
      ...(price[id] ? { pricing: { prompt: price[id], completion: price[id] } } : {}),
    })),
  });
}

function model(id: string, extra: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return {
    id,
    name: id,
    ownedBy: "openai",
    contextLength: 0,
    costInputPer1k: 0,
    costOutputPer1k: 0,
    priceSource: "none",
    ...extra,
  };
}

function seedProvider(discovered: DiscoveredModel[], extra: Partial<FakeProvider> = {}) {
  const row: FakeProvider = {
    id: `p${db.providers.size + 1}`,
    name: "Router",
    kind: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "sk-test",
    discovered,
    zdr: false,
    retentionDays: null,
    region: "",
    noTraining: false,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    updatedAt: new Date("2026-10-01T00:00:00.000Z"),
    ...extra,
  };
  db.providers.set(row.id, row);
  return row;
}

function load() {
  return import("@/lib/gateway/discovery");
}

beforeEach(() => {
  db.providers.clear();
  db.deployments = [];
  db.audit = [];
  db.webhook = "";
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("diffDiscovered reports added, removed, and repriced ids regardless of order", async () => {
  const { diffDiscovered } = await load();
  const diff = diffDiscovered(
    [model("b"), model("a", { costInputPer1k: 1, costOutputPer1k: 2 }), model("gone")],
    [model("new"), model("a", { costInputPer1k: 1, costOutputPer1k: 3 }), model("b")],
  );
  assert.deepEqual(diff.added, ["new"]);
  assert.deepEqual(diff.removed, ["gone"]);
  assert.deepEqual(diff.repriced, [{ id: "a", from: { in: 1, out: 2 }, to: { in: 1, out: 3 } }]);
  assert.equal(diff.changed, true);
});

test("diffDiscovered ignores reordering but notices metadata edits", async () => {
  const { diffDiscovered } = await load();
  const reordered = diffDiscovered([model("a"), model("b")], [model("b"), model("a")]);
  assert.equal(reordered.changed, false);
  const renamed = diffDiscovered([model("a")], [model("a", { name: "A v2" })]);
  assert.equal(renamed.changed, true);
  assert.deepEqual(renamed.added, []);
  assert.deepEqual(renamed.removed, []);
  assert.deepEqual(renamed.repriced, []);
});

test("fetchProviderModels maps OpenRouter pricing and sends attribution headers", async () => {
  const { fetchProviderModels } = await load();
  respondWith(() => modelsResponse(["openai/gpt-x"], { "openai/gpt-x": "0.000002" }));
  const models = await fetchProviderModels("openrouter", "https://openrouter.ai/api/v1", "sk-or");
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/models");
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer sk-or");
  assert.equal(headers["X-Title"], "LLM Hub");
  assert.equal(models.length, 1);
  assert.equal(models[0].priceSource, "provider");
  assert.equal(models[0].costInputPer1k, 0.002);
});

test("fetchProviderModels uses Anthropic headers and maps upstream errors to codes", async () => {
  const { fetchProviderModels } = await load();
  respondWith(() => modelsResponse(["claude-x"]));
  await fetchProviderModels("anthropic", "", "sk-ant");
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/models");
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], "sk-ant");
  assert.equal(headers.Authorization, undefined);

  respondWith(() => new Response("{}", { status: 401 }));
  await assert.rejects(fetchProviderModels("openai", "", "bad"), { message: "UPSTREAM_AUTH" });
  respondWith(() => new Response("{}", { status: 502 }));
  await assert.rejects(fetchProviderModels("openai", "", "k"), { message: "UPSTREAM_FAILED" });
  respondWith(() => Promise.reject(new TypeError("fetch failed")));
  await assert.rejects(fetchProviderModels("openai", "", "k"), { message: "UPSTREAM_FAILED" });
  await assert.rejects(fetchProviderModels("openai_compat", "", "k"), {
    message: "BASE_URL_REQUIRED",
  });
});

test("first refresh records a baseline without listing every model", async () => {
  const { refreshProviderModels } = await load();
  const row = seedProvider([]);
  respondWith(() => modelsResponse(["a", "b", "c"]));
  const { provider, diff } = await refreshProviderModels(row, "user-1");
  assert.equal((provider.discovered as DiscoveredModel[]).length, 3);
  assert.equal(diff.added.length, 3);
  assert.equal(db.audit.length, 1);
  assert.equal(db.audit[0].action, "provider.models_discovered");
  assert.equal(db.audit[0].actor, "user-1");
  assert.deepEqual(JSON.parse(db.audit[0].afterJson), {
    name: "Router",
    kind: "openrouter",
    count: 3,
  });
});

test("refresh records added and removed models and the groups still routing to them", async () => {
  const { refreshProviderModels } = await load();
  const row = seedProvider([model("keep"), model("old")]);
  db.deployments.push(
    { id: "d1", groupAlias: "old-alias", model: "old", providerId: row.id },
    { id: "d2", groupAlias: "keep", model: "keep", providerId: row.id },
    { id: "d3", groupAlias: "other", model: "old", providerId: "elsewhere" },
  );
  db.webhook = "https://hooks.example.test/llmhub";
  let alertBody = "";
  respondWith(async (url) => {
    if (url === db.webhook) {
      alertBody = String(calls.at(-1)?.init?.body ?? "");
      return new Response("ok");
    }
    return modelsResponse(["keep", "fresh"]);
  });

  const { diff } = await refreshProviderModels(row, "worker");
  assert.deepEqual(diff.added, ["fresh"]);
  assert.deepEqual(diff.removed, ["old"]);

  const changed = db.audit.find((a) => a.action === "provider.models_changed");
  assert.ok(changed);
  assert.equal(changed.actor, "worker");
  const after = JSON.parse(changed.afterJson);
  assert.deepEqual(after.added, ["fresh"]);
  assert.deepEqual(after.removed, ["old"]);
  assert.deepEqual(after.affected, [{ deployment: "d1", group: "old-alias", model: "old" }]);

  const alert = JSON.parse(alertBody);
  assert.equal(alert.event, "provider_models_changed");
  assert.match(alert.message, /1 added, 1 removed/);
  assert.match(alert.message, /removed old/);
  assert.match(alert.message, /old-alias/);
  assert.ok(db.audit.some((a) => a.action === "alert_delivered"));
});

test("refresh writes nothing when the provider list is unchanged", async () => {
  const { refreshProviderModels } = await load();
  const row = seedProvider([model("a", { ownedBy: "openrouter" })]);
  respondWith(() => modelsResponse(["a"]));
  const { provider, diff } = await refreshProviderModels(row, "worker");
  assert.equal(diff.changed, false);
  assert.equal(provider, row);
  assert.equal(db.audit.length, 0);
});

test("refresh keeps the previous list when the provider suddenly returns none", async () => {
  const { refreshProviderModels } = await load();
  const row = seedProvider([model("a")]);
  respondWith(() => modelsResponse([]));
  await assert.rejects(refreshProviderModels(row, "worker"), { message: "UPSTREAM_EMPTY" });
  assert.deepEqual(db.providers.get(row.id)?.discovered, [model("a")]);
  assert.equal(db.audit.length, 0);
});

test("refresh yields to a concurrent writer instead of double-recording", async () => {
  const { refreshProviderModels } = await load();
  const row = seedProvider([model("a")]);
  db.providers.set(row.id, { ...row, updatedAt: new Date("2026-10-02T00:00:00.000Z") });
  respondWith(() => modelsResponse(["a", "b"]));
  const { provider, diff } = await refreshProviderModels(row, "worker");
  assert.equal(diff.changed, false);
  assert.equal(provider.updatedAt.toISOString(), "2026-10-02T00:00:00.000Z");
  assert.equal(db.audit.length, 0);
});

test("runModelSync keeps going when one provider fails", async () => {
  const { runModelSync } = await import("@/worker/model-sync");
  seedProvider([model("a")], { name: "Broken", baseUrl: "https://broken.example.test/v1" });
  seedProvider([model("a")], { name: "Healthy", baseUrl: "https://healthy.example.test/v1" });
  respondWith((url) =>
    url.startsWith("https://broken.")
      ? new Response("{}", { status: 503 })
      : modelsResponse(["a", "b"]),
  );
  const result = await runModelSync();
  assert.deepEqual(result, { providers: 2, changed: 1, failed: 1 });
  assert.equal(db.audit.filter((a) => a.action === "provider.models_changed").length, 1);
});

test("worker schedules model sync hourly with a deduplicated boot run", async () => {
  const source = await readFile(path.join(root, "src/worker/schedules.ts"), "utf8");
  assert.match(source, /MODEL_SYNC_INTERVAL_MS = 3_600_000/);
  assert.match(source, /getModelsQueue\(\)/);
  assert.match(source, /deduplication: \{ id: "model-sync-boot"/);
  const boot = await readFile(path.join(root, "src/worker/boot.ts"), "utf8");
  assert.match(boot, /import\("\.\/model-sync"\)/);
  assert.match(boot, /clearInterval\(g\.__llmhubModelSyncTimer\)/);
});

test("provider actions share discovery instead of fetching inline", async () => {
  const source = await readFile(
    path.join(root, "src/app/(app)/providers/_action.ts"),
    "utf8",
  );
  assert.match(source, /refreshProviderModels\(row, session\.user\.id\)/);
  assert.doesNotMatch(source, /async function fetchModels/);
  assert.doesNotMatch(source, /fetch\(/);
});
