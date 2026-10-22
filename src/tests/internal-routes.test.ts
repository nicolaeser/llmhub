import { API_KEY, errorOf, gateway, gatewayRequest, resetGateway } from "./support/gateway-harness";
import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import test from "node:test";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { GateError } from "@/lib/gateway/errors";
import type { AuthenticatedSession } from "@/types/auth";
import type { JsonMap, Principal } from "@/types/gateway";

type FakeRoute = { id: string; kind: string; internal?: boolean; weight?: number; cost?: number; zdr?: boolean };

function deploymentRow(alias: string, route: FakeRoute) {
  return {
    id: route.id,
    groupAlias: alias,
    kind: route.kind,
    baseUrl: `https://${route.id}.test/v1`,
    model: alias,
    weight: route.weight ?? 1,
    costInput: route.cost ?? 0,
    costOutput: route.cost ?? 0,
    providerId: `provider-${route.id}`,
    provider: {
      id: `provider-${route.id}`,
      kind: route.kind,
      baseUrl: "",
      apiKey: "",
      zdr: route.zdr ?? false,
      retentionDays: null,
      region: "",
      noTraining: false,
      enabled: true,
      restricted: false,
      internal: route.internal ?? false,
      assignments: [],
      login: { status: "active" },
    },
  };
}

function groupRow(alias: string, routes: FakeRoute[], change: Record<string, unknown> = {}) {
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
    variants: [],
    overflowGroup: "",
    numRetries: 0,
    fallbackGroups: [],
    deployments: routes.map((route) => deploymentRow(alias, route)),
    ...change,
  };
}

const ROUTES = {
  privateChat: { id: "private-chat", kind: "openai_compat", internal: true },
  privateEmbed: { id: "private-embed", kind: "openai_compat", internal: true },
  mixedPrivate: { id: "mixed-private", kind: "openai_compat", internal: true, weight: 10, cost: 0.5, zdr: true },
  mixedPublic: { id: "mixed-public", kind: "openai_compat", cost: 0.002 },
  publicChat: { id: "public-chat", kind: "openai_compat" },
  planSeat: { id: "plan-seat", kind: "codex" },
  planPrivate: { id: "plan-private", kind: "openai_compat", internal: true },
  planOnlySeat: { id: "plan-only-seat", kind: "codex" },
} satisfies Record<string, FakeRoute>;

const groups = gateway.groups;
groups.clear();
for (const row of [
  groupRow("chat-private", [ROUTES.privateChat]),
  groupRow("embed-private", [ROUTES.privateEmbed]),
  groupRow("chat-mixed", [ROUTES.mixedPrivate, ROUTES.mixedPublic]),
  groupRow("chat-public", [ROUTES.publicChat]),
  groupRow("plan-private", [ROUTES.planSeat, ROUTES.planPrivate]),
  groupRow("plan-only", [ROUTES.planOnlySeat]),
  groupRow("overflows-to-private", [], { overflowGroup: "chat-private" }),
]) {
  groups.set(row.alias, row);
}

const caller: Principal = {
  actor: "user-1",
  teamId: "",
  orgId: "",
  userId: "user-1",
  memberId: "",
  models: [],
  routeLimits: {},
};

const pick = async (dep: { id: string }) => dep.id;

const UNKNOWN = { status: 404, message: "no deployment for model" };

const PUBLIC_MODEL_ROUTES: { path: string; load: () => Promise<{ POST: (req: Request) => Promise<Response> }>; body: (model: string) => JsonMap }[] = [
  {
    path: "/api/v1/chat/completions",
    load: () => import("@/app/api/v1/chat/completions/route"),
    body: (model) => ({ model, messages: [{ role: "user", content: "hi" }] }),
  },
  {
    path: "/api/v1/messages",
    load: () => import("@/app/api/v1/messages/route"),
    body: (model) => ({ model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
  },
  { path: "/api/v1/responses", load: () => import("@/app/api/v1/responses/route"), body: (model) => ({ model, input: "hi" }) },
  { path: "/api/v1/embeddings", load: () => import("@/app/api/v1/embeddings/route"), body: (model) => ({ model, input: "hi" }) },
  {
    path: "/api/subscription/v1/chat/completions",
    load: () => import("@/app/api/subscription/v1/chat/completions/route"),
    body: (model) => ({ model, messages: [{ role: "user", content: "hi" }] }),
  },
  {
    path: "/api/subscription/v1/messages",
    load: () => import("@/app/api/subscription/v1/messages/route"),
    body: (model) => ({ model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
  },
  {
    path: "/api/subscription/v1/responses",
    load: () => import("@/app/api/subscription/v1/responses/route"),
    body: (model) => ({ model, input: "hi" }),
  },
];

function upstreamHosts(): string[] {
  return gateway.upstream.map((call) => new URL(call.url).hostname);
}

function getRequest(url: string): Request {
  return new Request(`http://hub.local${url}`, { headers: { authorization: `Bearer ${API_KEY}` } });
}

function manager(): AuthenticatedSession {
  return {
    error: false,
    sessionId: "",
    user: { id: "u1", username: "ops", email: "ops@example.com", orgId: null } as AuthenticatedSession["user"],
    isOwner: false,
    role: null,
    permissions: [PERMISSIONS.PROVIDERS_READ, PERMISSIONS.PROVIDERS_MANAGE],
    secondFactor: "MANAGEMENT_KEY",
    ipAddress: null,
    userAgent: null,
  };
}

test("internal providers form their own pool that sign-in kinds never join", async () => {
  const { hiddenFrom, listedIn, routable, routePool } = await import("@/lib/gateway/routing/route-pool");
  const internal = { kind: "openai", provider: { kind: "openai", internal: true } };
  const api = { kind: "openai", provider: { kind: "openai", internal: false } };
  const plan = { kind: "codex", provider: { kind: "codex", internal: true } };
  assert.equal(routePool(internal), "internal");
  assert.equal(routePool(api), "api");
  assert.equal(routePool(plan), "subscription");
  assert.equal(routePool({ kind: "openai_compat", provider: null }), "api");
  assert.deepEqual([internal, api, plan].map(routable("internal")), [true, true, false]);
  assert.deepEqual([internal, api, plan].map(routable("api")), [false, true, false]);
  assert.deepEqual([internal, api, plan].map(routable("subscription")), [false, false, true]);
  assert.equal(hiddenFrom("api", [internal]), true);
  assert.equal(hiddenFrom("subscription", [internal, internal]), true);
  assert.equal(hiddenFrom("api", [internal, plan]), false);
  assert.equal(hiddenFrom("api", []), false);
  assert.equal(hiddenFrom("internal", [internal]), false);
  assert.equal(listedIn({ pools: ["internal"] }, "api"), false);
  assert.equal(listedIn({ pools: ["internal"] }, "subscription"), false);
  assert.equal(listedIn({ pools: ["internal", "api"] }, "api"), true);
});

test("model lists never show an internal-only alias and price mixed aliases by their public routes", async () => {
  const { pricedModels } = await import("@/lib/gateway/catalog/model-pricing");
  const { listedIn } = await import("@/lib/gateway/routing/route-pool");
  const { modelEntries } = await import("@/lib/gateway/endpoints/models-route");
  const created = new Date("2026-10-21T12:00:00Z");
  const models = await pricedModels(created);
  const listed = (pool: "api" | "subscription") => models.filter((model) => listedIn(model, pool)).map((model) => model.alias).sort();
  assert.deepEqual(listed("api"), ["chat-mixed", "chat-public", "overflows-to-private"]);
  assert.deepEqual(listed("subscription"), ["plan-only", "plan-private"]);
  const mixed = models.find((model) => model.alias === "chat-mixed")!;
  assert.deepEqual(mixed.pricing, { prompt: "0.000002", completion: "0.000002" });
  assert.deepEqual(mixed.pools.sort(), ["api", "internal"]);
  assert.deepEqual(
    modelEntries(models, "subscription", () => true, created).map((entry) => entry.id),
    ["plan-private", "plan-only", "api/chat-mixed", "api/chat-public", "api/overflows-to-private"],
  );

  const surfaces = {
    api: await import("@/app/api/v1/models/route"),
    subscription: await import("@/app/api/subscription/v1/models/route"),
    apiItem: await import("@/app/api/v1/models/[id]/route"),
    subscriptionItem: await import("@/app/api/subscription/v1/models/[id]/route"),
  };
  const list = async (route: { GET: (req: Request) => Promise<Response> }, url: string) =>
    ((await (await route.GET(getRequest(url))).json()) as { data: { id: string }[] }).data.map((entry) => entry.id);
  const apiList = await list(surfaces.api, "/api/v1/models");
  assert.ok(apiList.includes("chat-mixed") && !apiList.includes("chat-private") && !apiList.includes("embed-private"), apiList.join());
  const planList = await list(surfaces.subscription, "/api/subscription/v1/models");
  assert.ok(planList.includes("api/chat-mixed") && !planList.some((id) => id.endsWith("chat-private")), planList.join());
  const retrieve = async (route: { GET: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response> }, url: string, id: string) =>
    (await route.GET(getRequest(url), { params: Promise.resolve({ id }) })).status;
  assert.equal(await retrieve(surfaces.apiItem, "/api/v1/models/chat-private", "chat-private"), 404);
  assert.equal(await retrieve(surfaces.apiItem, "/api/v1/models/chat-mixed", "chat-mixed"), 200);
  assert.equal(await retrieve(surfaces.subscriptionItem, "/api/subscription/v1/models/api%2Fchat-private", "api/chat-private"), 404);
  assert.equal(await retrieve(surfaces.subscriptionItem, "/api/subscription/v1/models/chat-private", "chat-private"), 404);
});

test("public model routes answer an internal-only alias exactly like an unknown model", async () => {
  for (const route of PUBLIC_MODEL_ROUTES) {
    const { POST } = await route.load();
    resetGateway();
    const subscription = route.path.startsWith("/api/subscription/");
    const models = subscription ? ["chat-private", "api/chat-private", "api/embed-private"] : ["chat-private", "embed-private"];
    const unknown = await errorOf(await POST(gatewayRequest(route.path, route.body(subscription ? "api/no-such-model" : "no-such-model"))));
    assert.deepEqual(unknown, UNKNOWN, route.path);
    for (const model of models) {
      const hidden = await errorOf(await POST(gatewayRequest(route.path, route.body(model))));
      assert.deepEqual(hidden, unknown, `${route.path} ${model}`);
    }
    assert.deepEqual(gateway.upstream, [], route.path);
  }
});

test("batch lines, auto, fallbacks, and overflow never reach an internal route", async () => {
  const { runBatchLine } = await import("@/lib/gateway/endpoints/batches");
  const { POST } = await import("@/app/api/v1/chat/completions/route");
  const chat = (model: string, extra: JsonMap = {}) => ({ model, messages: [{ role: "user", content: "hi" }], ...extra });
  resetGateway();
  const unknown = await runBatchLine(caller, "/v1/chat/completions", chat("no-such-model"));
  for (const [endpoint, body] of [
    ["/v1/chat/completions", chat("chat-private")],
    ["/v1/responses", { model: "chat-private", input: "hi" }],
    ["/v1/embeddings", { model: "embed-private", input: "hi" }],
  ] as const) {
    const line = await runBatchLine(caller, endpoint, body);
    assert.deepEqual(line, unknown, endpoint);
  }
  assert.equal(unknown.ok, false);
  assert.deepEqual(gateway.upstream, []);

  const auto = [deploymentRow("chat-private", ROUTES.privateChat), deploymentRow("auto-public", { id: "auto-public", kind: "openai_compat", cost: 0.003 })];
  recordedPrisma.base.deployment = { findMany: () => auto };
  try {
    const res = await POST(gatewayRequest("/api/v1/chat/completions", chat("auto")));
    assert.equal(res.status, 200);
    assert.deepEqual(upstreamHosts(), ["auto-public.test"]);
  } finally {
    delete recordedPrisma.base.deployment;
  }

  const original = gateway.reply;
  groups.set("flaky-admin", groupRow("flaky-admin", [{ id: "flaky-admin", kind: "openai_compat" }], { fallbackGroups: ["chat-private"] }));
  groups.set("flaky-caller", groupRow("flaky-caller", [{ id: "flaky-caller", kind: "openai_compat" }]));
  try {
    resetGateway();
    gateway.reply = (call) => (call.url.includes("flaky") ? Response.json({ error: { message: "boom" } }, { status: 500 }) : original(call));
    const admin = await POST(gatewayRequest("/api/v1/chat/completions", chat("flaky-admin")));
    const viaCaller = await POST(gatewayRequest("/api/v1/chat/completions", chat("flaky-caller", { fallbacks: ["chat-private"] })));
    const overflow = await POST(gatewayRequest("/api/v1/chat/completions", chat("overflows-to-private")));
    assert.notEqual(admin.status, 200);
    assert.notEqual(viaCaller.status, 200);
    assert.notEqual(overflow.status, 200);
    assert.deepEqual(upstreamHosts(), ["flaky-admin.test", "flaky-caller.test"]);
  } finally {
    gateway.reply = original;
    groups.delete("flaky-admin");
    groups.delete("flaky-caller");
  }
});

test("a mixed alias serves only its public routes on public surfaces", async () => {
  const { withDeployment } = await import("@/lib/gateway/dispatch/chat");
  const { forwardToModel } = await import("@/lib/gateway/dispatch/upstream");
  const { POST } = await import("@/app/api/v1/chat/completions/route");
  resetGateway();
  assert.equal((await withDeployment(["chat-mixed"], {}, pick)).result, "mixed-public");
  assert.equal((await withDeployment(["api/chat-mixed"], {}, pick, { pool: "subscription" })).result, "mixed-public");
  assert.equal((await withDeployment(["plan-private"], {}, pick, { pool: "subscription" })).result, "plan-seat");
  await assert.rejects(
    withDeployment(["plan-private"], {}, pick),
    (err: unknown) => err instanceof GateError && err.status === 404 && err.message.includes("/api/subscription/v1"),
  );
  await assert.rejects(
    withDeployment(["api/plan-private"], {}, pick, { pool: "subscription" }),
    (err: unknown) => err instanceof GateError && err.status === 404 && err.message === "model has no API route",
  );
  assert.equal((await forwardToModel(["chat-mixed"], caller, "/embeddings", { input: "hi" })).depId, "mixed-public");
  const res = await POST(gatewayRequest("/api/v1/chat/completions", { model: "chat-mixed", messages: [{ role: "user", content: "hi" }] }));
  assert.equal(res.status, 200);
  assert.deepEqual(upstreamHosts(), ["mixed-public.test", "mixed-public.test"]);
});

test("internal callers reach internal and API routes but never a subscription", async () => {
  const { withDeployment } = await import("@/lib/gateway/dispatch/chat");
  const { forwardToModel } = await import("@/lib/gateway/dispatch/upstream");
  resetGateway();
  const internal = { pool: "internal" as const };
  assert.equal((await withDeployment(["chat-private"], {}, pick, internal)).result, "private-chat");
  assert.equal((await withDeployment(["chat-mixed"], {}, pick, internal)).result, "mixed-private");
  assert.equal((await withDeployment(["chat-public"], {}, pick, internal)).result, "public-chat");
  assert.equal((await withDeployment(["plan-private"], {}, pick, internal)).result, "plan-private");
  assert.equal((await withDeployment(["overflows-to-private"], {}, pick, internal)).result, "private-chat");
  await assert.rejects(
    withDeployment(["plan-only"], {}, pick, internal),
    (err: unknown) => err instanceof GateError && err.status === 404 && err.message === "model is only served by subscriptions",
  );
  groups.set("falls-to-private", groupRow("falls-to-private", [{ id: "falls-public", kind: "openai_compat" }], { fallbackGroups: ["chat-private"] }));
  try {
    const failing = async (dep: { id: string }) => {
      if (dep.id === "falls-public") throw new GateError(500, "upstream_error", "boom");
      return dep.id;
    };
    assert.equal((await withDeployment(["falls-to-private"], {}, failing, internal)).result, "private-chat");
  } finally {
    groups.delete("falls-to-private");
  }

  const embed = { input: "hi" };
  assert.equal((await forwardToModel(["embed-private"], caller, "/embeddings", embed, internal)).depId, "private-embed");
  assert.equal((await forwardToModel(["plan-private"], caller, "/embeddings", embed, internal)).depId, "plan-private");
  assert.equal((await forwardToModel(["chat-public"], caller, "/embeddings", embed, internal)).depId, "public-chat");
  await assert.rejects(
    forwardToModel(["plan-only"], caller, "/embeddings", embed, internal),
    (err: unknown) => err instanceof GateError && err.status === 404,
  );
  await assert.rejects(
    forwardToModel(["embed-private"], caller, "/embeddings", embed),
    (err: unknown) => err instanceof GateError && err.status === 404 && err.message === UNKNOWN.message,
  );
  assert.deepEqual(upstreamHosts(), ["private-embed.test", "plan-private.test", "public-chat.test"]);
});

test("internal callers can bound an upstream call with their own timeout", async () => {
  const { forwardToModel } = await import("@/lib/gateway/dispatch/upstream");
  groups.set("slow-private", groupRow("slow-private", [{ id: "slow-private", kind: "openai_compat", internal: true }]));
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })) as typeof fetch;
  try {
    const started = Date.now();
    await assert.rejects(
      forwardToModel(["slow-private"], caller, "/embeddings", { input: "hi" }, { pool: "internal", timeoutMs: 50 }),
      (err: unknown) => err instanceof GateError && err.status === 502,
    );
    assert.ok(Date.now() - started < 5_000);
  } finally {
    globalThis.fetch = fetchBefore;
    groups.delete("slow-private");
  }
});

test("template matching, console model lists, and the MCP builder ignore internal routes", async () => {
  const { loadModelPolicies } = await import("@/lib/gateway/access/model-access");
  const { templateModels } = await import("@/lib/gateway/access/model-policy");
  const { apiModelChoices, enabledModelChoices } = await import("@/lib/models/aliases");
  const { builderModels } = await import("@/lib/mcp/builder");
  resetGateway();
  recordedPrisma.reset({
    providerConnection: {
      findMany: () =>
        [...groups.values()].flatMap((row) =>
          (row as ReturnType<typeof groupRow>).deployments.map((dep) => ({
            id: dep.provider.id,
            zdr: dep.provider.zdr,
            retentionDays: null,
            region: "",
            noTraining: false,
          })),
        ),
    },
  });
  const policies = await loadModelPolicies();
  const aliases = policies.map((policy) => policy.alias);
  assert.equal(aliases.includes("chat-private") || aliases.includes("embed-private"), false, aliases.join());
  assert.ok(aliases.includes("chat-mixed") && aliases.includes("plan-private"));
  const rules = { models: [], patterns: [], providerIds: [], regions: [], zdrOnly: true, noTrainingOnly: false, maxRetentionDays: null };
  assert.deepEqual(templateModels(rules, policies), []);
  assert.deepEqual(templateModels({ ...rules, zdrOnly: false, patterns: ["*"] }, policies).sort(), aliases.sort());

  const choices = await enabledModelChoices();
  assert.deepEqual(choices.find((choice) => choice.alias === "chat-private")?.pools, ["internal"]);
  assert.deepEqual((await apiModelChoices()).map((choice) => choice.alias).sort(), ["chat-mixed", "chat-public", "overflows-to-private"]);
  const builder = (await builderModels()).map((model) => model.alias);
  assert.deepEqual(builder.sort(), ["chat-mixed", "chat-public"]);
});

test("sign-in providers cannot become internal and the flag reaches the management API", async () => {
  const { createProvider, updateProvider } = await import("@/lib/providers/connections");
  const { providerCreateSchema, providerUpdateSchema } = await import("@/schemas/management");
  const { serializeProvider } = await import("@/lib/management/serialize");
  const { problemFromError } = await import("@/lib/http/problem");
  resetGateway();
  recordedPrisma.reset({
    providerConnection: {
      findUnique: () => ({ id: "plan", name: "Plan", kind: "codex", baseUrl: "", apiKey: "", enabled: true, internal: false }),
    },
  });
  const session = manager();
  for (const kind of ["codex", "claude", "grok_build", "antigravity", "kimi", "muse_code", "devin"]) {
    await assert.rejects(
      runAsPrincipal(session, () => createProvider({ name: "", kind, baseUrl: "", apiKey: "", internal: true })),
      /INTERNAL_SIGN_IN/,
      kind,
    );
  }
  await assert.rejects(
    runAsPrincipal(session, () => updateProvider({ id: "plan", name: "", baseUrl: "", apiKey: "", internal: true })),
    /INTERNAL_SIGN_IN/,
  );
  assert.equal(recordedPrisma.called("providerConnection", "create").length, 0);
  assert.equal(recordedPrisma.called("providerConnection", "update").length, 0);

  const problem = problemFromError(new Request("http://hub.local/api/mgmt/providers"), new Error("INTERNAL_SIGN_IN"));
  assert.equal(problem.status, 422);
  assert.equal(((await problem.json()) as { code: string }).code, "INTERNAL_SIGN_IN");
  assert.equal(providerCreateSchema.parse({ kind: "openai" }).internal, false);
  assert.equal(providerCreateSchema.parse({ kind: "openai", internal: true }).internal, true);
  assert.deepEqual(providerUpdateSchema.parse({ internal: false }), { internal: false });
  assert.equal(providerUpdateSchema.safeParse({ internal: "yes" }).success, false);
  const view = {
    id: "p1",
    name: "Private",
    kind: "openai",
    baseUrl: "",
    hasApiKey: true,
    enabled: true,
    restricted: false,
    internal: true,
    assignments: [],
    signIn: null,
    sharedVia: null,
    manageActive: false,
    discovered: [],
    policy: { zdr: false, retentionDays: null, region: "", noTraining: false },
    vertex: null,
  };
  assert.equal(serializeProvider(view).internal, true);
});
