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
  modelGroup: {
    findUnique: async ({ where }: { where: { alias: string } }) => groups.get(where.alias) ?? null,
    findMany: async () => [...groups.values()],
  },
};

const app = fileURLToPath(new URL("../src/app", import.meta.url));
const subscriptionApp = path.join(app, "subscription");

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
  const { gatewayPath } = await import("@/lib/gateway/route-pool");
  const { wantsAnthropicErrors } = await import("@/lib/gateway/gate");
  assert.equal(gatewayPath("/subscription/v1/messages"), "/v1/messages");
  assert.equal(gatewayPath("/subscriptions/v1/messages"), "/subscriptions/v1/messages");
  assert.equal(gatewayPath("/v1/messages"), "/v1/messages");
  assert.equal(wantsAnthropicErrors(new Request("http://hub.test/subscription/v1/messages")), true);
  assert.equal(wantsAnthropicErrors(new Request("http://hub.test/subscription/v1/chat/completions")), false);
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

test("/v1 never routes to subscriptions and /subscription/v1 never routes to API keys", async () => {
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
    (err: unknown) => err instanceof GateError && err.status === 404 && err.message.includes("/subscription/v1"),
  );
  await assert.rejects(
    withDeployment(["gpt-api"], {}, pick, { pool: "subscription" }),
    (err: unknown) => err instanceof GateError && err.status === 404 && err.message === "model has no subscription route",
  );
  await assert.rejects(
    forwardToModel(["grok-build"], apiCaller, "/embeddings", { input: "hi" }),
    (err: unknown) => err instanceof GateError && err.status === 404 && err.message.includes("/subscription/v1"),
  );
});

test("subscription paths run the /v1 handlers in the subscription pool and expose only text endpoints", () => {
  const dirs = routeDirs(subscriptionApp);
  assert.deepEqual(dirs, ["v1/chat/completions", "v1/messages", "v1/models", "v1/models/[id]", "v1/responses"]);
  for (const dir of dirs) {
    const subscription = readFileSync(path.join(subscriptionApp, dir, "route.ts"), "utf8");
    const v1 = readFileSync(path.join(app, dir, "route.ts"), "utf8");
    const factory = /export const (GET|POST) = (\w+)\("subscription"\);/.exec(subscription);
    assert.ok(factory, dir);
    assert.match(v1, new RegExp(`export const ${factory[1]} = ${factory[2]}\\("api"\\);`), dir);
    assert.equal(/maxDuration = 300/.test(subscription), /maxDuration = 300/.test(v1), dir);
  }
});
