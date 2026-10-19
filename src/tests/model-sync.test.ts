import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import type { AuthenticatedSession } from "@/types/auth";
import type { GlobalWithWorkerBoot } from "@/types/jobs";
import type { DiscoveredModel } from "@/types/providers";

const root = fileURLToPath(new URL("../..", import.meta.url));

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
  enabled: boolean;
  restricted: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type FakeDeployment = {
  id: string;
  groupAlias: string;
  model: string;
  providerId: string;
  kind?: string;
  costInput?: number;
  costOutput?: number;
};

type FakeGroup = {
  alias: string;
  vendor: string;
  displayName: string;
  autoRoutes: boolean | null;
  enabled: boolean;
  strategy?: string;
};

type FakeEntry = {
  providerId: string;
  upstreamId: string;
  name: string;
  vendor: string;
  alias: string;
  source: string;
  confidence: number;
  disabled: boolean;
  classifiedAt: Date | null;
  updatedAt: Date;
};

const db = {
  providers: new Map<string, FakeProvider>(),
  deployments: [] as FakeDeployment[],
  groups: [] as FakeGroup[],
  entries: new Map<string, FakeEntry>(),
  settings: new Map<string, string>(),
  audit: [] as { actor: string; action: string; objectId: string; afterJson: string }[],
  webhook: "",
  enterprise: {} as Record<string, unknown>,
};

const entryKey = (row: { providerId: string; upstreamId: string }) => `${row.providerId}|${row.upstreamId}`;

function duplicate(): Error {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

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
    findMany: async ({ where }: { where?: { providerId: string; model: { in: string[] } } } = {}) =>
      where
        ? db.deployments.filter((d) => d.providerId === where.providerId && where.model.in.includes(d.model))
        : db.deployments,
    create: async ({ data }: { data: Omit<FakeDeployment, "id"> }) => {
      const row = { id: `d${db.deployments.length + 1}`, ...data };
      db.deployments.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<FakeDeployment> }) => {
      const row = db.deployments.find((d) => d.id === where.id);
      if (row) Object.assign(row, data);
      return row ?? {};
    },
    deleteMany: async ({ where }: { where: { groupAlias: string; providerId: string; model: string } }) => {
      const before = db.deployments.length;
      db.deployments = db.deployments.filter(
        (d) => !(d.groupAlias === where.groupAlias && d.providerId === where.providerId && d.model === where.model),
      );
      return { count: before - db.deployments.length };
    },
  },
  modelGroup: {
    findMany: async () => db.groups,
    findUnique: async ({ where }: { where: { alias: string } }) => {
      const group = db.groups.find((row) => row.alias === where.alias);
      if (!group) return null;
      return { ...group, deployments: db.deployments.filter((d) => d.groupAlias === group.alias) };
    },
    create: async ({
      data,
    }: {
      data: Omit<FakeGroup, "enabled" | "autoRoutes"> & {
        autoRoutes?: boolean | null;
        deployments: { create: Omit<FakeDeployment, "id" | "groupAlias"> };
      };
    }) => {
      if (db.groups.some((row) => row.alias === data.alias)) throw duplicate();
      const { deployments, ...group } = data;
      db.groups.push({ enabled: true, autoRoutes: null, ...group });
      db.deployments.push({ id: `d${db.deployments.length + 1}`, groupAlias: data.alias, ...deployments.create });
      return group;
    },
    update: async ({ where, data }: { where: { alias: string }; data: Partial<FakeGroup> }) => {
      const group = db.groups.find((row) => row.alias === where.alias);
      if (group) Object.assign(group, data);
      return group;
    },
  },
  catalogEntry: {
    findMany: async ({ where }: { where?: { alias?: string } } = {}) =>
      [...db.entries.values()].filter((row) => !where?.alias || row.alias === where.alias),
    findUnique: async ({ where }: { where: { providerId_upstreamId: { providerId: string; upstreamId: string } } }) =>
      db.entries.get(entryKey(where.providerId_upstreamId)) ?? null,
    createMany: async ({ data }: { data: Omit<FakeEntry, "updatedAt">[] }) => {
      for (const row of data) {
        if (!db.entries.has(entryKey(row))) db.entries.set(entryKey(row), { ...row, updatedAt: new Date() });
      }
      return { count: data.length };
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { providerId: string; upstreamId: string; updatedAt: Date };
      data: Partial<FakeEntry>;
    }) => {
      const row = db.entries.get(entryKey(where));
      if (!row || row.updatedAt.getTime() !== where.updatedAt.getTime()) return { count: 0 };
      db.entries.set(entryKey(where), { ...row, ...data, updatedAt: new Date(row.updatedAt.getTime() + 1) });
      return { count: 1 };
    },
    update: async ({
      where,
      data,
    }: {
      where: { providerId_upstreamId: { providerId: string; upstreamId: string } };
      data: Partial<FakeEntry>;
    }) => {
      const key = entryKey(where.providerId_upstreamId);
      const row = db.entries.get(key)!;
      db.entries.set(key, { ...row, ...data, updatedAt: new Date(row.updatedAt.getTime() + 1) });
      return db.entries.get(key);
    },
    upsert: async ({
      where,
      update,
      create,
    }: {
      where: { providerId_upstreamId: { providerId: string; upstreamId: string } };
      update: Partial<FakeEntry>;
      create: Omit<FakeEntry, "updatedAt" | "classifiedAt">;
    }) => {
      const key = entryKey(where.providerId_upstreamId);
      const row = db.entries.get(key);
      db.entries.set(
        key,
        row
          ? { ...row, ...update, updatedAt: new Date(row.updatedAt.getTime() + 1) }
          : { classifiedAt: null, ...create, updatedAt: new Date() },
      );
      return db.entries.get(key);
    },
    deleteMany: async ({ where }: { where: { providerId: string; upstreamId: { in: string[] } } }) => {
      let count = 0;
      for (const upstreamId of where.upstreamId.in) {
        if (db.entries.delete(entryKey({ providerId: where.providerId, upstreamId }))) count += 1;
      }
      return { count };
    },
  },
  gatewayAuditLog: {
    create: async ({ data }: { data: (typeof db.audit)[number] }) => {
      db.audit.push(data);
      return data;
    },
  },
  setting: {
    findUnique: async ({ where }: { where: { key: string } }) => {
      if (where.key === "enterprise") {
        return {
          key: where.key,
          value: JSON.stringify({ ...db.enterprise, ...(db.webhook ? { alert_webhook: db.webhook } : {}) }),
        };
      }
      const value = db.settings.get(where.key);
      return value === undefined ? null : { key: where.key, value };
    },
    create: async ({ data }: { data: { key: string; value: string } }) => {
      if (db.settings.has(data.key)) throw duplicate();
      db.settings.set(data.key, data.value);
      return data;
    },
    upsert: async ({ where, update }: { where: { key: string }; update: { value: string } }) => {
      db.settings.set(where.key, update.value);
      return { key: where.key, value: update.value };
    },
    deleteMany: async ({ where }: { where: { key: string; value?: string | { lt: string } } }) => {
      const value = db.settings.get(where.key);
      const match =
        value !== undefined &&
        (where.value === undefined ||
          (typeof where.value === "string" ? value === where.value : value < where.value.lt));
      if (match) db.settings.delete(where.key);
      return { count: match ? 1 : 0 };
    },
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
    enabled: true,
    restricted: false,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    updatedAt: new Date("2026-10-01T00:00:00.000Z"),
    ...extra,
  };
  db.providers.set(row.id, row);
  return row;
}

function load() {
  return import("@/lib/gateway/upstreams/discovery");
}

beforeEach(() => {
  db.providers.clear();
  db.deployments = [];
  db.groups = [];
  db.entries.clear();
  db.settings.clear();
  db.audit = [];
  db.webhook = "";
  db.enterprise = {};
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
  assert.deepEqual(result, { providers: 2, changed: 1, failed: 1, skipped: false });
  assert.equal(db.audit.filter((a) => a.action === "provider.models_changed").length, 1);
  const state = JSON.parse(db.settings.get("model_catalog_state") ?? "{}");
  assert.deepEqual(
    state.failed.map((row: { name: string; code: string }) => [row.name, row.code]),
    [["Broken", "UPSTREAM_FAILED"]],
  );
  assert.equal(db.settings.has("model_catalog_lock"), false);
});

test("runModelSync serves the cached catalog until two hours have passed", async () => {
  const { runModelSync } = await import("@/worker/model-sync");
  seedProvider([model("a")]);
  respondWith(() => modelsResponse(["a"]));
  assert.equal((await runModelSync()).skipped, false);
  const fetches = calls.length;
  assert.deepEqual(await runModelSync(), { providers: 0, changed: 0, failed: 0, skipped: true });
  assert.equal(calls.length, fetches);

  const state = JSON.parse(db.settings.get("model_catalog_state")!);
  db.settings.set("model_catalog_state", JSON.stringify({ ...state, refreshedAt: new Date(Date.now() - 7_200_000).toISOString() }));
  assert.equal((await runModelSync()).skipped, false);
  assert.ok(calls.length > fetches);
});

test("a manual refresh bypasses the cache but never runs twice at once", async () => {
  const { refreshCatalog } = await import("@/lib/gateway/catalog/catalog-sync");
  seedProvider([model("a")]);
  respondWith(() => modelsResponse(["a"]));
  await refreshCatalog({ actor: "worker", force: false });
  assert.equal((await refreshCatalog({ actor: "user-1", force: true })).skipped, false);

  db.settings.set("model_catalog_lock", String(Date.now() + 60_000));
  await assert.rejects(refreshCatalog({ actor: "user-1", force: true }), { message: "CATALOG_BUSY" });
  db.settings.set("model_catalog_state", JSON.stringify({ refreshedAt: "2026-01-01T00:00:00.000Z" }));
  assert.equal((await refreshCatalog({ actor: "worker", force: false })).skipped, true);

  db.settings.set("model_catalog_lock", String(Date.now() - 1));
  assert.equal((await refreshCatalog({ actor: "worker", force: false })).skipped, false);
});

test("the catalog groups the same model across providers and keeps routes and aliases stable", async () => {
  const { refreshCatalog } = await import("@/lib/gateway/catalog/catalog-sync");
  const router = seedProvider([], { name: "OpenRouter" });
  respondWith(() => modelsResponse(["anthropic/claude-sonnet-4.5"]));
  await refreshCatalog({ actor: "worker", force: true });
  assert.equal(db.entries.get(`${router.id}|anthropic/claude-sonnet-4.5`)?.alias, "claude-sonnet-4.5");

  const direct = seedProvider([], {
    name: "Anthropic",
    kind: "anthropic",
    baseUrl: "https://anthropic.example.test",
  });
  respondWith((url) =>
    url.startsWith("https://anthropic.")
      ? modelsResponse(["claude-sonnet-4-5-20250929"])
      : modelsResponse(["anthropic/claude-sonnet-4.5"]),
  );
  await refreshCatalog({ actor: "worker", force: true });
  const entry = db.entries.get(`${direct.id}|claude-sonnet-4-5-20250929`);
  assert.equal(entry?.alias, "claude-sonnet-4.5");
  assert.equal(entry?.source, "rule");
  assert.equal(entry?.vendor, "anthropic");
  assert.equal(db.deployments.length, 0);
});

test("aliases with automatic routing take in trusted new providers only", async () => {
  const { refreshCatalog } = await import("@/lib/gateway/catalog/catalog-sync");
  db.groups.push({ alias: "gpt-4o", vendor: "openai", displayName: "", autoRoutes: true, enabled: true });
  const router = seedProvider([], { name: "OpenRouter" });
  const local = seedProvider([], {
    name: "Local",
    kind: "openai_compat",
    baseUrl: "https://local.example.test/v1",
  });
  respondWith((url) =>
    url.startsWith("https://local.") ? modelsResponse(["gpt-4o"]) : modelsResponse(["openai/gpt-4o"]),
  );
  await refreshCatalog({ actor: "worker", force: true });
  assert.deepEqual(
    db.deployments.map((d) => [d.groupAlias, d.providerId, d.model]),
    [["gpt-4o", router.id, "openai/gpt-4o"]],
  );
  assert.equal(db.entries.get(`${router.id}|openai/gpt-4o`)?.source, "route");
  assert.equal(db.entries.get(`${local.id}|gpt-4o`)?.alias, "gpt-4o");
  assert.notEqual(db.entries.get(`${local.id}|gpt-4o`)?.source, "route");
  assert.ok(db.audit.some((a) => a.action === "catalog.auto_route"));

  db.deployments = [];
  await refreshCatalog({ actor: "worker", force: true });
  assert.equal(db.deployments.length, 0);
  assert.equal(db.entries.get(`${router.id}|openai/gpt-4o`)?.alias, "gpt-4o");
});

test("Jev groups differently named models on its own OpenRouter key", async () => {
  const { refreshCatalog } = await import("@/lib/gateway/catalog/catalog-sync");
  db.enterprise = { catalog_jev: { enabled: true, model: "jev-latest", api_key: "sk-or-jev" } };
  db.groups.push({
    alias: "llama-3.3-70b-instruct",
    vendor: "meta-llama",
    displayName: "Llama 3.3 70B Instruct",
    autoRoutes: true,
    enabled: true,
  });
  const groq = seedProvider([], { name: "Groq", kind: "openai_compat", baseUrl: "https://groq.example.test/v1" });
  let jevBody: Record<string, unknown> = {};
  respondWith((url) => {
    if (url.endsWith("/systemone")) {
      jevBody = JSON.parse(String(calls.at(-1)?.init?.body));
      return Response.json({
        model: "typesafe/jev-1.13",
        answers: {
          same_model: {
            type: "choice",
            choice: "llama-3.3-70b-instruct",
            confidence: 0.9,
            probabilities: { "llama-3.3-70b-instruct": 0.96, none: 0.04 },
          },
        },
        usage: { input_tokens: 120, output_tokens: 0, cost: 0.000005 },
      });
    }
    return modelsResponse(["llama-3.3-70b-versatile"]);
  });
  const { state } = await refreshCatalog({ actor: "worker", force: true });
  const jevCall = calls.find((call) => call.url.endsWith("/systemone"));
  assert.equal(jevCall?.url, "https://openrouter.ai/api/v1/systemone");
  assert.equal((jevCall?.init?.headers as Record<string, string>).Authorization, "Bearer sk-or-jev");
  assert.equal(jevBody.model, "jev-latest");
  assert.deepEqual(Object.keys((jevBody.questions as { same_model: { criteria: object } }).same_model.criteria), [
    "llama-3.3-70b-instruct",
    "none",
  ]);
  const entry = db.entries.get(`${groq.id}|llama-3.3-70b-versatile`);
  assert.equal(entry?.alias, "llama-3.3-70b-instruct");
  assert.equal(entry?.source, "jev");
  assert.equal(entry?.confidence, 0.96);
  assert.ok(entry?.classifiedAt);
  assert.equal(db.deployments.length, 0);
  const { settings, ...jev } = state!.jev;
  assert.deepEqual(jev, { configured: true, asked: 1, matched: 1, pending: 0, cost: 0.000005, error: "" });
  assert.match(settings, /^[0-9a-f]{16}$/);

  const asked = calls.filter((call) => call.url.endsWith("/systemone")).length;
  await refreshCatalog({ actor: "worker", force: true });
  assert.equal(calls.filter((call) => call.url.endsWith("/systemone")).length, asked);
  assert.equal(db.entries.get(`${groq.id}|llama-3.3-70b-versatile`)?.source, "jev");
});

test("a rejected Jev key stops the run and is reported", async () => {
  const { refreshCatalog } = await import("@/lib/gateway/catalog/catalog-sync");
  db.enterprise = { catalog_jev: { enabled: true, model: "jev-latest", api_key: "sk-or-bad" } };
  db.groups.push({ alias: "llama-3.3-70b-instruct", vendor: "", displayName: "", autoRoutes: false, enabled: true });
  seedProvider([], { name: "Groq", kind: "openai_compat", baseUrl: "https://groq.example.test/v1" });
  respondWith((url) =>
    url.endsWith("/systemone") ? new Response("{}", { status: 401 }) : modelsResponse(["llama-3.3-70b-versatile"]),
  );
  const { state } = await refreshCatalog({ actor: "worker", force: true });
  assert.equal(state?.jev.error, "JEV_AUTH");
  assert.equal(state?.jev.pending, 1);
  assert.equal([...db.entries.values()][0]?.classifiedAt, null);
});

test("turning a provider off removes its route and keeps it off across refreshes", async () => {
  const { refreshCatalog, setEntryActive, setGroupActive } = await import("@/lib/gateway/catalog/catalog-sync");
  const router = seedProvider([], { name: "OpenRouter" });
  respondWith(() => modelsResponse(["openai/gpt-4o", "openai/gpt-4o:free"]));
  await refreshCatalog({ actor: "worker", force: true });
  assert.equal(db.entries.get(`${router.id}|openai/gpt-4o:free`)?.alias, "gpt-4o:free");

  await setGroupActive("user-1", "gpt-4o", true);
  assert.deepEqual(db.groups.map((g) => [g.alias, g.vendor, g.autoRoutes]), [["gpt-4o", "openai", null]]);
  assert.deepEqual(db.deployments.map((d) => d.model), ["openai/gpt-4o"]);

  await setEntryActive("user-1", { providerId: router.id, upstreamId: "openai/gpt-4o" }, false);
  assert.equal(db.deployments.length, 0);
  assert.equal(db.entries.get(`${router.id}|openai/gpt-4o`)?.disabled, true);
  await refreshCatalog({ actor: "worker", force: true });
  assert.equal(db.deployments.length, 0);
  assert.equal(db.entries.get(`${router.id}|openai/gpt-4o`)?.alias, "gpt-4o");

  await setEntryActive("user-1", { providerId: router.id, upstreamId: "openai/gpt-4o" }, true);
  assert.deepEqual(db.deployments.map((d) => d.model), ["openai/gpt-4o"]);
  assert.equal(db.entries.get(`${router.id}|openai/gpt-4o`)?.disabled, false);

  await setGroupActive("user-1", "gpt-4o", false);
  assert.equal(db.groups[0]?.enabled, false);
});

test("moving a provider model to another alias carries its active route along", async () => {
  const { assignEntry, refreshCatalog, setEntryActive } = await import("@/lib/gateway/catalog/catalog-sync");
  const router = seedProvider([], { name: "OpenRouter" });
  respondWith(() => modelsResponse(["openai/gpt-4o"]));
  await refreshCatalog({ actor: "worker", force: true });
  const ref = { providerId: router.id, upstreamId: "openai/gpt-4o" };
  await setEntryActive("user-1", ref, true);
  assert.deepEqual(db.deployments.map((d) => d.groupAlias), ["gpt-4o"]);

  await assignEntry("user-1", ref, "chat-default");
  assert.deepEqual(db.deployments.map((d) => [d.groupAlias, d.model]), [["chat-default", "openai/gpt-4o"]]);
  assert.equal(db.entries.get(`${router.id}|openai/gpt-4o`)?.alias, "chat-default");
  assert.equal(db.entries.get(`${router.id}|openai/gpt-4o`)?.source, "route");
  await assert.rejects(assignEntry("user-1", ref, "auto"), { message: "ALIAS_RESERVED" });

  await refreshCatalog({ actor: "worker", force: true });
  assert.equal(db.entries.get(`${router.id}|openai/gpt-4o`)?.alias, "chat-default");
});

test("the global default decides for aliases without their own automatic routing setting", async () => {
  const { refreshCatalog } = await import("@/lib/gateway/catalog/catalog-sync");
  db.groups.push(
    { alias: "gpt-4o", vendor: "openai", displayName: "", autoRoutes: null, enabled: true },
    { alias: "grok-4", vendor: "xai", displayName: "", autoRoutes: false, enabled: true },
  );
  const router = seedProvider([], { name: "OpenRouter" });
  respondWith(() => modelsResponse(["openai/gpt-4o", "x-ai/grok-4"]));
  db.enterprise = { catalog_auto_routes: false };
  await refreshCatalog({ actor: "worker", force: true });
  assert.equal(db.deployments.length, 0);

  db.entries.clear();
  db.enterprise = {};
  await refreshCatalog({ actor: "worker", force: true });
  assert.deepEqual(
    db.deployments.map((d) => [d.groupAlias, d.providerId]),
    [["gpt-4o", router.id]],
  );
});

test("worker schedules the model catalog every two hours with a deduplicated boot run", async () => {
  const source = await readFile(path.join(root, "src/worker/schedules.ts"), "utf8");
  assert.match(source, /MODEL_SYNC_INTERVAL_MS = 7_200_000/);
  assert.match(source, /getModelsQueue\(\)/);
  assert.match(source, /deduplication: \{ id: "model-sync-boot"/);
  const boot = await readFile(path.join(root, "src/worker/boot.ts"), "utf8");
  assert.match(boot, /import\("\.\/model-sync"\)/);
  assert.match(boot, /MODEL_SYNC_TICK_MS = 7_200_000/);
  assert.match(boot, /clearInterval\(g\.__llmhubModelSyncTimer\)/);
});

test("provider discovery in the console runs the shared refresh as the signed-in user", async () => {
  const { runAsPrincipal } = await import("@/lib/auth/delegation");
  const { discoverProvider } = await import("@/lib/providers/connections");
  const admin: AuthenticatedSession = {
    error: false,
    sessionId: "s1",
    user: { id: "admin-1", username: "admin", orgId: null } as AuthenticatedSession["user"],
    isOwner: true,
    role: null,
    permissions: ["providers:manage"],
    secondFactor: "TOTP",
    ipAddress: null,
    userAgent: null,
  };
  const row = seedProvider([]);
  respondWith(() => modelsResponse(["openai/gpt-x", "anthropic/claude-x"]));
  const first = await runAsPrincipal(admin, () => discoverProvider(row.id));
  assert.deepEqual(first.models.map((candidate) => candidate.id), ["openai/gpt-x", "anthropic/claude-x"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/models");
  assert.equal((calls[0].init?.headers as Record<string, string>)["X-Title"], "LLM Hub");
  assert.equal((db.providers.get(row.id)!.discovered as DiscoveredModel[]).length, 2);
  assert.deepEqual(
    db.audit.map((entry) => [entry.action, entry.actor]),
    [["provider.models_discovered", "admin-1"]],
  );
  await runAsPrincipal(admin, () => discoverProvider(row.id));
  assert.equal(calls.length, 2);
  assert.equal(db.audit.length, 1);
});

function jevAnswer(choice: string, probability: number) {
  return Response.json({
    answers: { same_model: { type: "choice", choice, probabilities: { [choice]: probability } } },
    usage: { cost: 0.00001 },
  });
}

function catalogTimers() {
  return (globalThis as GlobalWithWorkerBoot).__llmhubCatalogTimers ?? new Map();
}

test("Jev splits a long candidate list into rounds and lets the round winners compete", async () => {
  const { refreshCatalog } = await import("@/lib/gateway/catalog/catalog-sync");
  db.enterprise = { catalog_jev: { enabled: true, model: "jev-latest", api_key: "sk-or-jev" } };
  const suffixes = ["base", "chat", "deep", "fast", "instruct", "lite", "max", "mini", "nano", "plus", "pro", "turbo"];
  for (const suffix of suffixes) {
    db.groups.push({ alias: `llama-3.3-70b-${suffix}`, vendor: "", displayName: "", autoRoutes: false, enabled: true });
  }
  const groq = seedProvider([], { name: "Groq", kind: "openai_compat", baseUrl: "https://groq.example.test/v1" });
  const rounds: string[][] = [];
  respondWith((url) => {
    if (!url.endsWith("/systemone")) return modelsResponse(["llama-3.3-70b-versatile"]);
    const body = JSON.parse(String(calls.at(-1)?.init?.body));
    const offered = Object.keys(body.questions.same_model.criteria).filter((alias) => alias !== "none");
    rounds.push(offered);
    if (offered.includes("llama-3.3-70b-instruct")) {
      return jevAnswer("llama-3.3-70b-instruct", offered.length === 2 ? 0.95 : 0.8);
    }
    return jevAnswer(offered[0]!, 0.7);
  });
  const { state } = await refreshCatalog({ actor: "worker", force: true });
  assert.deepEqual(
    rounds.map((offered) => offered.length),
    [8, 4, 2],
  );
  assert.deepEqual(rounds[2], ["llama-3.3-70b-instruct", "llama-3.3-70b-nano"]);
  const entry = db.entries.get(`${groq.id}|llama-3.3-70b-versatile`);
  assert.equal(entry?.alias, "llama-3.3-70b-instruct");
  assert.equal(entry?.confidence, 0.95);
  assert.equal(state?.jev.asked, 1);
  assert.ok(Math.abs((state?.jev.cost ?? 0) - 0.00003) < 1e-12);
});

test("provider price changes reach routes that used the list price and spare custom prices", async () => {
  const { refreshProviderModels } = await load();
  const priced = { costInputPer1k: 0.001, costOutputPer1k: 0.001, priceSource: "provider" };
  const row = seedProvider([model("openai/gpt-4o", priced)]);
  db.deployments.push(
    { id: "d1", groupAlias: "gpt-4o", model: "openai/gpt-4o", providerId: row.id, costInput: 0.001, costOutput: 0.001 },
    { id: "d2", groupAlias: "gpt-4o-deal", model: "openai/gpt-4o", providerId: row.id, costInput: 0.0005, costOutput: 0.0005 },
  );
  respondWith(() => modelsResponse(["openai/gpt-4o"], { "openai/gpt-4o": "0.000002" }));
  await refreshProviderModels(row, "worker");
  assert.deepEqual(
    db.deployments.map((d) => [d.id, d.costInput, d.costOutput]),
    [
      ["d1", 0.002, 0.002],
      ["d2", 0.0005, 0.0005],
    ],
  );
  assert.deepEqual(JSON.parse(db.audit.at(-1)!.afterJson).repricedRoutes, ["d1"]);
});

test("routes keep their price when the provider stops publishing one", async () => {
  const { followingRoutes } = await load();
  const routes = [{ id: "d1", model: "m", costInput: 0.001, costOutput: 0.002 }];
  assert.deepEqual(followingRoutes(routes, [{ id: "m", from: { in: 0.001, out: 0.002 }, to: { in: 0, out: 0 } }]), []);
  assert.deepEqual(
    followingRoutes(routes, [{ id: "m", from: { in: 0.0010000000000000002, out: 0.002 }, to: { in: 0.003, out: 0.004 } }]),
    [{ id: "d1", model: "m", to: { in: 0.003, out: 0.004 } }],
  );
});

test("a provider task fetches only that provider and keeps the regular refresh schedule", async () => {
  const { runModelSync } = await import("@/worker/model-sync");
  seedProvider([model("a")], { name: "First", baseUrl: "https://first.example.test/v1" });
  respondWith((url) => (url.startsWith("https://first.") ? new Response("{}", { status: 503 }) : modelsResponse(["a"])));
  await runModelSync();
  const before = JSON.parse(db.settings.get("model_catalog_state")!);

  const second = seedProvider([], { name: "Second", baseUrl: "https://second.example.test/v1" });
  calls = [];
  respondWith(() => modelsResponse(["openai/gpt-4o"]));
  const result = await runModelSync({ task: "provider", providerId: second.id });
  assert.deepEqual(
    calls.map((call) => call.url),
    ["https://second.example.test/v1/models"],
  );
  const after = JSON.parse(db.settings.get("model_catalog_state")!);
  assert.equal(after.refreshedAt, before.refreshedAt);
  assert.equal(after.providers, 2);
  assert.deepEqual(
    after.failed.map((row: { name: string }) => row.name),
    ["First"],
  );
  assert.ok(db.entries.has(`${second.id}|openai/gpt-4o`));
  assert.equal(result.skipped, false);

  db.settings.set("model_catalog_lock", String(Date.now() + 60_000));
  await assert.rejects(runModelSync({ task: "provider", providerId: second.id }), { message: "CATALOG_BUSY" });
});

test("Jev works through long lists in steps and stops on a rejected key", async () => {
  const { jevFollowUpDelay, JEV_STEP_DELAY_MS, JEV_RATE_LIMIT_DELAY_MS, stopLocalCatalogTasks } = await import(
    "@/lib/gateway/catalog/catalog-tasks"
  );
  const { runModelSync } = await import("@/worker/model-sync");
  const jev = (extra: Record<string, unknown>) =>
    ({ jev: { configured: true, asked: 100, matched: 0, pending: 5, cost: 0, error: "", ...extra } }) as Parameters<
      typeof jevFollowUpDelay
    >[0];
  assert.equal(jevFollowUpDelay(jev({})), JEV_STEP_DELAY_MS);
  assert.equal(jevFollowUpDelay(jev({ error: "JEV_RATE_LIMITED" })), JEV_RATE_LIMIT_DELAY_MS);
  assert.equal(jevFollowUpDelay(jev({ error: "JEV_CREDITS" })), null);
  assert.equal(jevFollowUpDelay(jev({ asked: 0, error: "JEV_FAILED" })), null);
  assert.equal(jevFollowUpDelay(jev({ pending: 0 })), null);

  db.enterprise = { catalog_jev: { enabled: true, model: "jev-latest", api_key: "sk-or-jev" } };
  db.groups.push({ alias: "llama-3.3-70b-instruct", vendor: "", displayName: "", autoRoutes: false, enabled: true });
  seedProvider([], { name: "Groq", kind: "openai_compat", baseUrl: "https://groq.example.test/v1" });
  const ids = Array.from({ length: 101 }, (_, n) => `llama-3.3-70b-v${n}`);
  respondWith((url) => (url.endsWith("/systemone") ? jevAnswer("none", 0.9) : modelsResponse(ids)));
  try {
    await runModelSync();
    const state = JSON.parse(db.settings.get("model_catalog_state")!);
    assert.deepEqual([state.jev.asked, state.jev.pending], [100, 1]);
    assert.ok(catalogTimers().has("catalog-rebuild"));
  } finally {
    stopLocalCatalogTasks();
  }
  assert.equal(catalogTimers().size, 0);
});

test("only plain catalog groups disappear with their last provider", async () => {
  const { catalogOwnedGroups } = await import("@/lib/providers/provider-removal");
  const plain = {
    enabled: true,
    billingMode: "routed",
    overflowGroup: "",
    fallbackGroups: [],
    autoRoutes: null,
    _count: { priceWindows: 0 },
  };
  assert.deepEqual(
    catalogOwnedGroups(
      [
        { alias: "gpt-4o", ...plain },
        { alias: "fallback-target", ...plain },
        { alias: "custom-price", ...plain, billingMode: "custom" },
        { alias: "pinned", ...plain, autoRoutes: true },
        { alias: "paused", ...plain, enabled: false },
        { alias: "with-fallback", ...plain, fallbackGroups: ["gpt-4o"] },
        { alias: "windowed", ...plain, _count: { priceWindows: 1 } },
      ],
      new Set(["fallback-target"]),
    ),
    ["gpt-4o"],
  );
});

test("a rejected Jev key stays visible until the key changes, then Jev runs again", async () => {
  const { refreshCatalog, loadCatalogView } = await import("@/lib/gateway/catalog/catalog-sync");
  const { stopLocalCatalogTasks } = await import("@/lib/gateway/catalog/catalog-tasks");
  db.enterprise = { catalog_jev: { enabled: true, model: "jev-latest", api_key: "sk-or-bad" } };
  db.groups.push({ alias: "llama-3.3-70b-instruct", vendor: "", displayName: "", autoRoutes: false, enabled: true });
  seedProvider([], { name: "Groq", kind: "openai_compat", baseUrl: "https://groq.example.test/v1" });
  respondWith((url) =>
    url.endsWith("/systemone") ? new Response("{}", { status: 401 }) : modelsResponse(["llama-3.3-70b-versatile"]),
  );
  await refreshCatalog({ actor: "worker", force: true });
  try {
    assert.equal((await loadCatalogView()).state?.jev.error, "JEV_AUTH");
    assert.equal(catalogTimers().size, 0);

    db.enterprise = { catalog_jev: { enabled: true, model: "jev-latest", api_key: "sk-or-fixed" } };
    assert.equal((await loadCatalogView()).state?.jev.error, "");
    assert.ok(catalogTimers().has("catalog-rebuild"));
  } finally {
    stopLocalCatalogTasks();
  }
});
