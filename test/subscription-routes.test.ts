import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GateError } from "@/lib/gateway/errors";
import type { Principal } from "@/types/gateway";

type FakeRoute = { id: string; kind: string };

function groupRow(alias: string, routes: FakeRoute[]) {
  return {
    alias,
    enabled: true,
    vendor: "openai",
    displayName: "",
    strategy: "priority",
    billingMode: "routed",
    priceInput: 0,
    priceOutput: 0,
    priceTimeZone: "UTC",
    priceWindows: [],
    overflowGroup: "",
    numRetries: 0,
    fallbackGroups: [],
    deployments: routes.map((route) => ({
      id: route.id,
      kind: route.kind,
      baseUrl: "",
      model: alias,
      weight: 1,
      costInput: 0,
      costOutput: 0,
      providerId: `provider-${route.id}`,
      provider: {
        id: `provider-${route.id}`,
        kind: route.kind,
        baseUrl: "",
        apiKey: "",
        zdr: false,
        retentionDays: null,
        region: "",
        noTraining: false,
      },
    })),
  };
}

const groups = new Map(
  [
    groupRow("gpt-5.5", [
      { id: "chatgpt", kind: "codex" },
      { id: "openai", kind: "openai" },
    ]),
    groupRow("grok-build", [{ id: "supergrok", kind: "grok_build" }]),
    groupRow("gpt-api", [{ id: "openai-only", kind: "openai" }]),
    groupRow("overflow-only", []),
  ].map((row) => [row.alias, row]),
);

(globalThis as { prisma?: unknown }).prisma = {
  accountRouting: { findMany: async () => [] },
  modelGroup: {
    findUnique: async ({ where }: { where: { alias: string } }) => groups.get(where.alias) ?? null,
    findMany: async () => [...groups.values()],
  },
};

const app = fileURLToPath(new URL("../src/app", import.meta.url));
const gatewayApp = path.join(app, "api");
const subscriptionApp = path.join(gatewayApp, "subscription");

function routeDirs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...routeDirs(full));
    else if (entry.name === "route.ts") out.push(path.relative(subscriptionApp, dir).split(path.sep).join("/"));
  }
  return out.sort();
}

test("subscription paths keep the gateway error shapes", async () => {
  const { gatewayPath } = await import("@/lib/gateway/api-paths");
  const { wantsAnthropicErrors } = await import("@/lib/gateway/gate");
  assert.equal(gatewayPath("/api/subscription/v1/messages"), "/v1/messages");
  assert.equal(gatewayPath("/api/v1/messages"), "/v1/messages");
  assert.equal(gatewayPath("/subscription/v1/messages"), "/v1/messages");
  assert.equal(gatewayPath("/v1/messages"), "/v1/messages");
  assert.equal(gatewayPath("/api/subscriptions/v1/messages"), "/api/subscriptions/v1/messages");
  assert.equal(gatewayPath("/api/mgmt/keys"), "/api/mgmt/keys");
  assert.equal(gatewayPath("/api/v1"), "/api/v1");
  assert.equal(wantsAnthropicErrors(new Request("http://hub.test/api/subscription/v1/messages")), true);
  assert.equal(wantsAnthropicErrors(new Request("http://hub.test/api/v1/messages")), true);
  assert.equal(wantsAnthropicErrors(new Request("http://hub.test/api/subscription/v1/chat/completions")), false);
});

test("signed-in providers form the subscription pool and every other route the API pool", async () => {
  const { listedIn, routePool } = await import("@/lib/gateway/route-pool");
  const { AUTO_MODEL } = await import("@/lib/gateway/core");
  assert.equal(routePool({ kind: "codex" }), "subscription");
  assert.equal(routePool({ kind: "grok_build", provider: { kind: "grok_build" } }), "subscription");
  assert.equal(routePool({ kind: "openai", provider: { kind: "codex" } }), "subscription");
  assert.equal(routePool({ kind: "xai", provider: { kind: "xai" } }), "api");
  assert.equal(routePool({ kind: "openai_compat", provider: null }), "api");
  assert.equal(listedIn({ pools: [] }, "api"), true);
  assert.equal(listedIn({ pools: [] }, "subscription"), false);
  assert.equal(listedIn({ pools: ["subscription"] }, "api"), false);
  assert.equal(listedIn(AUTO_MODEL, "api") && listedIn(AUTO_MODEL, "subscription"), true);
});

test("model lists show only the aliases each path can serve", async () => {
  const { pricedModels } = await import("@/lib/gateway/model-pricing");
  const { listedIn } = await import("@/lib/gateway/route-pool");
  const models = await pricedModels(new Date());
  const listed = (pool: "api" | "subscription") =>
    models.filter((model) => listedIn(model, pool)).map((model) => model.alias).sort();
  assert.deepEqual(listed("api"), ["gpt-5.5", "gpt-api", "overflow-only"]);
  assert.deepEqual(listed("subscription"), ["gpt-5.5", "grok-build"]);
});

test("/api/v1 never routes to subscriptions and /api/subscription/v1 reaches API keys only through the api/ prefix", async () => {
  const { withDeployment } = await import("@/lib/gateway/chat");
  const { forwardToModel } = await import("@/lib/gateway/upstream");
  const pick = async (dep: { id: string }) => dep.id;
  const apiCaller: Principal = {
    actor: "u1",
    teamId: "",
    orgId: "",
    userId: "u1",
    memberId: "",
    models: [],
    routeLimits: {},
  };

  assert.equal((await withDeployment(["gpt-5.5"], {}, pick)).result, "openai");
  assert.equal((await withDeployment(["gpt-5.5"], {}, pick, { pool: "subscription" })).result, "chatgpt");
  assert.equal((await withDeployment(["grok-build"], {}, pick, { pool: "subscription" })).result, "supergrok");

  await assert.rejects(
    withDeployment(["grok-build"], {}, pick),
    (err: unknown) => err instanceof GateError && err.status === 404 && err.message.includes("/api/subscription/v1"),
  );
  await assert.rejects(
    withDeployment(["gpt-api"], {}, pick, { pool: "subscription" }),
    (err: unknown) => err instanceof GateError && err.status === 404 && err.message === "model has no subscription route",
  );
  await assert.rejects(
    forwardToModel(["grok-build"], apiCaller, "/embeddings", { input: "hi" }),
    (err: unknown) => err instanceof GateError && err.status === 404 && err.message.includes("/api/subscription/v1"),
  );
});

test("subscription paths run the /api/v1 handlers in the subscription pool and expose only text endpoints", () => {
  const dirs = routeDirs(subscriptionApp);
  assert.deepEqual(dirs, ["v1/chat/completions", "v1/messages", "v1/models", "v1/models/[id]", "v1/responses"]);
  for (const dir of dirs) {
    const subscription = readFileSync(path.join(subscriptionApp, dir, "route.ts"), "utf8");
    const v1 = readFileSync(path.join(gatewayApp, dir, "route.ts"), "utf8");
    const factory = /export const (GET|POST) = (\w+)\("subscription"\);/.exec(subscription);
    assert.ok(factory, dir);
    assert.match(v1, new RegExp(`export const ${factory[1]} = ${factory[2]}\\("api"\\);`), dir);
    assert.equal(/maxDuration = 300/.test(subscription), /maxDuration = 300/.test(v1), dir);
  }
});

test("the api/ prefix selects the API pool on the subscription surface only", async () => {
  const { routeOf } = await import("@/lib/gateway/route-pool");
  const { isReservedAlias, plainModel } = await import("@/lib/gateway/model-alias");
  assert.deepEqual(routeOf("api/gpt-5.5", "subscription"), { alias: "gpt-5.5", pool: "api" });
  assert.deepEqual(routeOf("gpt-5.5", "subscription"), { alias: "gpt-5.5", pool: "subscription" });
  assert.deepEqual(routeOf(" API/GPT-5.5 ", "subscription"), { alias: "GPT-5.5", pool: "api" });
  assert.deepEqual(routeOf("api/gpt-5.5", "api"), { alias: "api/gpt-5.5", pool: "api" });
  assert.deepEqual(routeOf("api/", "subscription"), { alias: "api/", pool: "subscription" });
  assert.deepEqual(routeOf("apiary", "subscription"), { alias: "apiary", pool: "subscription" });
  assert.equal(plainModel("api/claude-x"), "claude-x");
  assert.equal(plainModel("API/claude-x"), "claude-x");
  assert.equal(plainModel("claude-x"), "claude-x");
  assert.equal(plainModel("api/"), "api/");
  assert.equal(isReservedAlias("auto"), true);
  assert.equal(isReservedAlias("api/claude-x"), true);
  assert.equal(isReservedAlias("apiary"), false);
  assert.equal(isReservedAlias("gpt-5.5"), false);
});

test("a prefixed model runs on the API pool and a fallback can move from plan quota to the API", async () => {
  const { withDeployment } = await import("@/lib/gateway/chat");
  const { isRouterError } = await import("@/lib/gateway/core");
  const pick = async (dep: { id: string }) => dep.id;
  const surface = { pool: "subscription" as const };
  assert.equal((await withDeployment(["api/gpt-5.5"], {}, pick, surface)).result, "openai");
  assert.equal((await withDeployment(["gpt-5.5"], {}, pick, surface)).result, "chatgpt");
  groups.set("mixed-limited", groupRow("mixed-limited", [{ id: "plan-seat", kind: "codex" }, { id: "paygo", kind: "openai" }]));
  try {
    const limited = async (dep: { id: string }) => {
      if (dep.id === "plan-seat") throw new GateError(429, "rate_limit_exceeded", "limit reached");
      return dep.id;
    };
    const routed = await withDeployment(["mixed-limited", "api/mixed-limited"], {}, limited, surface);
    assert.equal(routed.result, "paygo");
    assert.equal(routed.alias, "mixed-limited");
    await assert.rejects(
      withDeployment(["mixed-limited"], {}, limited, surface),
      (err: unknown) => err instanceof GateError && err.status === 429,
    );
  } finally {
    groups.delete("mixed-limited");
  }
  await assert.rejects(
    withDeployment(["api/grok-build"], {}, pick, surface),
    (err: unknown) => err instanceof GateError && err.status === 404 && err.message === "model has no API route",
  );
  await assert.rejects(withDeployment(["api/gpt-5.5"], {}, pick), (err: unknown) => isRouterError(err, "unknown_group"));
});

test("model access follows the plain alias for prefixed models", async () => {
  const { modelPermitted } = await import("@/lib/gateway/gate");
  const caller: Principal = {
    actor: "u1",
    teamId: "",
    orgId: "",
    userId: "u1",
    memberId: "",
    models: ["gpt-5.5"],
    routeLimits: {},
    pool: "subscription",
  };
  assert.equal(modelPermitted(caller, "gpt-5.5"), true);
  assert.equal(modelPermitted(caller, "api/gpt-5.5"), true);
  assert.equal(modelPermitted(caller, "api/gpt-api"), false);
  assert.equal(modelPermitted({ ...caller, pool: "api" }, "api/gpt-5.5"), false);
  assert.equal(modelPermitted({ ...caller, models: ["*"] }, "api/anything"), true);
  assert.equal(modelPermitted({ ...caller, models: [] }, "api/anything"), true);
});

test("the subscription model list adds the API models with the api/ prefix and a route field", async () => {
  const { pricedModels } = await import("@/lib/gateway/model-pricing");
  const { modelEntries } = await import("@/lib/gateway/models-route");
  const { AUTO_MODEL } = await import("@/lib/gateway/core");
  const created = new Date("2026-10-12T12:00:00Z");
  const models = [...(await pricedModels(created)), AUTO_MODEL];
  const all = () => true;
  const sub = modelEntries(models, "subscription", all, created);
  assert.deepEqual(
    sub.map((entry) => `${entry.id}:${entry.route}`),
    [
      "gpt-5.5:subscription",
      "grok-build:subscription",
      "auto:subscription",
      "api/gpt-5.5:api",
      "api/gpt-api:api",
      "api/overflow-only:api",
      "api/auto:api",
    ],
  );
  assert.equal(sub[0]!.display_name, "gpt-5.5");
  assert.equal(sub[3]!.display_name, "gpt-5.5 (API)");
  const api = modelEntries(models, "api", all, created);
  assert.deepEqual(
    api.map((entry) => entry.id),
    ["gpt-5.5", "gpt-api", "overflow-only", "auto"],
  );
  assert.equal(api.some((entry) => "route" in entry), false);
  const limited = modelEntries(models, "subscription", (alias) => alias !== "gpt-api" && alias !== "grok-build", created);
  assert.deepEqual(
    limited.map((entry) => entry.id),
    ["gpt-5.5", "auto", "api/gpt-5.5", "api/overflow-only", "api/auto"],
  );
});

test("a model served by both pools is priced per pool", async () => {
  const { pricedModels } = await import("@/lib/gateway/model-pricing");
  const row = groupRow("priced-mixed", [{ id: "p-sub", kind: "codex" }, { id: "p-api", kind: "openai" }]);
  row.deployments[1]!.costInput = 0.002;
  row.deployments[1]!.costOutput = 0.006;
  groups.set("priced-mixed", row);
  try {
    const model = (await pricedModels(new Date())).find((entry) => entry.alias === "priced-mixed");
    assert.deepEqual(model!.pricing, { prompt: "0.000002", completion: "0.000006" });
    assert.equal(model!.subscriptionPricing, null);
    assert.deepEqual(model!.pools.sort(), ["api", "subscription"]);
  } finally {
    groups.delete("priced-mixed");
  }
});
