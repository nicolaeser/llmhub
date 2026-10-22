import { chatReply, gateway, resetGateway } from "./support/gateway-harness";
import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import test from "node:test";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { GateError } from "@/lib/gateway/errors";
import { BUILDER_MODEL_KEY } from "@/schemas/mcp";
import type { AuthenticatedSession, Permission } from "@/types/auth";
import type { JsonMap, Principal } from "@/types/gateway";
import type { VirtualKeyView } from "@/types/keys";
import type { JevTask } from "@/types/model-catalog";
import type { UsageSlice } from "@/types/usage";

type FakeRoute = { id: string; kind: string; internal?: boolean };

function groupRow(alias: string, routes: FakeRoute[], change: Record<string, unknown> = {}) {
  return {
    alias,
    enabled: true,
    vendor: "",
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
    deployments: routes.map((route) => ({
      id: route.id,
      groupAlias: alias,
      kind: route.kind,
      baseUrl: `https://${route.id}.test/v1`,
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
        enabled: true,
        restricted: false,
        internal: route.internal ?? false,
        assignments: [],
        login: { status: "active" },
      },
    })),
    ...change,
  };
}

const groups = gateway.groups;
groups.clear();
for (const row of [
  groupRow("chat-private", [{ id: "private-chat", kind: "openai_compat", internal: true }]),
  groupRow("chat-public", [{ id: "public-chat", kind: "openai_compat" }]),
  groupRow("chat-plan", [{ id: "plan-seat", kind: "codex" }]),
  groupRow("jev-private", [{ id: "private-jev", kind: "openai_compat", internal: true }]),
  groupRow("text-embed-private", [{ id: "private-embed", kind: "openai_compat", internal: true }]),
  groupRow("text-embed-public", [{ id: "public-embed", kind: "openai_compat" }]),
  groupRow("rerank-private", [{ id: "private-rerank", kind: "openai_compat", internal: true }]),
  groupRow("rerank-public", [{ id: "public-rerank", kind: "openai_compat" }]),
  groupRow("text-embed-off", [{ id: "off-embed", kind: "openai_compat", internal: true }], { enabled: false }),
]) {
  groups.set(row.alias, row);
}

function keyView(change: Partial<VirtualKeyView> = {}): VirtualKeyView {
  return {
    token_id: "key-1",
    key_name: "sk-hub-test",
    key_alias: "test",
    user_id: "user-1",
    team_id: "",
    org_id: "",
    project_id: "",
    member_id: "",
    models: ["chat-public"],
    templates: [],
    max_budget: 0,
    spend: 0,
    rpm_limit: 0,
    tpm_limit: 0,
    max_request_cost: 0,
    budget_duration: "",
    expires: "",
    allowed_ips: [],
    allowed_endpoints: [],
    access_windows: [],
    access_time_zone: "UTC",
    blocked: false,
    pii: null,
    log_content: true,
    created_at: "",
    ...change,
  };
}

function caller(change: Partial<Principal> = {}): Principal {
  return {
    actor: "sk-hub-test",
    key: keyView(),
    teamId: "",
    orgId: "",
    userId: "user-1",
    memberId: "",
    models: ["chat-public"],
    routeLimits: {},
    pool: "api",
    ...change,
  };
}

function session(permissions: Permission[], orgId: string | null = null): AuthenticatedSession {
  return {
    error: false,
    sessionId: "",
    user: { id: "u1", username: "ops", email: "ops@example.com", orgId } as AuthenticatedSession["user"],
    isOwner: false,
    role: null,
    permissions,
    secondFactor: "MANAGEMENT_KEY",
    ipAddress: null,
    userAgent: null,
  };
}

const platformAdmin = session([PERMISSIONS.SETTINGS_READ, PERMISSIONS.SETTINGS_MANAGE, PERMISSIONS.MCP_MANAGE]);

function settingsWith(values: Record<string, string>) {
  return {
    setting: {
      findUnique: ({ where }: { where: { key: string } }) => {
        if (where.key === "enterprise") return { key: where.key, value: JSON.stringify(gateway.enterprise) };
        return where.key in values ? { key: where.key, value: values[where.key] } : null;
      },
    },
  };
}

function upstreamHosts(): string[] {
  return gateway.upstream.map((call) => new URL(call.url).hostname);
}

function systemRows(endpoint: string) {
  const usage = recordedPrisma.called("usageDaily", "upsert").map((call) => (call.args as { where: { slice: JsonMap } }).where.slice);
  const logs = recordedPrisma
    .called("requestLog", "create")
    .map((call) => (call.args as { data: JsonMap }).data)
    .filter((row) => row.endpoint === endpoint);
  return { usage, logs };
}

function assertSystemMetered(endpoint: string, model: string) {
  const { usage, logs } = systemRows(endpoint);
  assert.ok(usage.length > 0, endpoint);
  for (const slice of usage) {
    assert.deepEqual(
      [slice.keyId, slice.userId, slice.memberId, slice.projectId, slice.teamId, slice.orgId],
      ["", "", "", "", "", ""],
    );
    assert.equal(slice.model, model);
  }
  assert.ok(logs.length > 0, endpoint);
  for (const row of logs) {
    assert.equal(row.contentSkip, "system");
    assert.equal(row.content, undefined);
    assert.deepEqual([row.keyId, row.userId, row.orgId, row.teamId, row.memberId, row.projectId], ["", "", "", "", "", ""]);
  }
}

test("a system principal has no caller, no budget holder, and routes on the internal surface", async () => {
  const { systemPrincipal } = await import("@/lib/gateway/access/system-principal");
  const { budgetChain } = await import("@/lib/gateway/billing/billing");
  const principal = systemPrincipal("mcp_builder");
  assert.equal(principal.actor, "system:mcp_builder");
  assert.deepEqual(
    [principal.teamId, principal.orgId, principal.userId, principal.memberId, principal.key],
    ["", "", "", "", undefined],
  );
  assert.deepEqual(principal.models, []);
  assert.deepEqual(principal.routeLimits, {});
  assert.equal(principal.pool, "internal");
  assert.equal(principal.system, true);
  assert.equal(principal.trace?.endpoint, "internal:mcp_builder");
  assert.deepEqual(budgetChain(principal), []);
  assert.notEqual(systemPrincipal("catalog").trace, systemPrincipal("catalog").trace);

  const { contentSkip } = await import("@/lib/gateway/request-logs/request-log");
  assert.equal(await contentSkip(principal, {}), "system");
});

test("the feature model registry reads every admin-chosen model from its setting", async () => {
  const { FEATURE_MODELS, featureModel, featureRoles, ROLE_KIND } = await import("@/lib/models/feature-models");
  resetGateway();
  gateway.enterprise = {
    cache_semantic: { enabled: true, model: "Text-Embed-Private", threshold: 0.9 },
    catalog_jev: { enabled: true, model: "jev-private", api_key: "" },
    vector_stores: { embedding_model: "text-embed-public", embedding_dimensions: 0, ocr_model: "ocr-x", rerank_model: "rerank-private" },
  };
  recordedPrisma.reset(settingsWith({ [BUILDER_MODEL_KEY]: "chat-private" }));
  assert.deepEqual(Object.keys(FEATURE_MODELS).sort(), ["cache", "catalog", "knowledge", "mcp_builder"]);
  assert.deepEqual(featureRoles("knowledge"), ["embedding", "ocr", "rerank"]);
  assert.deepEqual(featureRoles("mcp_builder"), ["chat"]);
  assert.deepEqual(featureRoles("catalog"), ["jev"]);
  assert.equal(await featureModel("mcp_builder", "chat"), "chat-private");
  assert.equal(await featureModel("catalog", "jev"), "jev-private");
  assert.equal(await featureModel("cache", "embedding"), "text-embed-private");
  assert.equal(await featureModel("knowledge", "embedding"), "text-embed-public");
  assert.equal(await featureModel("knowledge", "ocr"), "ocr-x");
  assert.equal(await featureModel("knowledge", "rerank"), "rerank-private");
  assert.equal(await featureModel("cache", "chat"), "");
  assert.equal(ROLE_KIND.jev, "chat");

  gateway.enterprise = {};
  recordedPrisma.reset();
  assert.equal(await featureModel("catalog", "jev"), "jev-latest");
  assert.equal(await featureModel("mcp_builder", "chat"), "");
});

test("pickers list aliases routable on the internal surface and the playground never lists internal ones", async () => {
  const { assertModelRoles, featureModelChoices, loadAliases } = await import("@/lib/models/aliases");
  const { builderModels } = await import("@/lib/mcp/builder");
  resetGateway();
  const choices = await featureModelChoices();
  const listed = Object.fromEntries(choices.map((choice) => [choice.alias, choice.internal]));
  assert.equal(listed["chat-private"], true);
  assert.equal(listed["chat-public"], false);
  assert.equal(listed["text-embed-private"], true);
  assert.equal("chat-plan" in listed, false);
  assert.deepEqual(
    (await builderModels()).filter((model) => model.alias.startsWith("chat-")),
    [
      { alias: "chat-private", label: "chat-private", internal: true },
      { alias: "chat-public", label: "chat-public", internal: false },
    ],
  );

  await assertModelRoles([{ alias: "text-embed-private", role: "embedding" }]);
  await assertModelRoles([{ alias: "chat-private", role: "rerank" }]);
  await assert.rejects(assertModelRoles([{ alias: "chat-plan", role: "embedding" }]), /MODEL_NOT_ROUTABLE/);
  await assert.rejects(assertModelRoles([{ alias: "text-embed-off", role: "embedding" }]), /MODEL_NOT_ROUTABLE/);
  await assert.rejects(assertModelRoles([{ alias: "no-such-model", role: "embedding" }]), /UNKNOWN_MODEL/);
  await assert.rejects(assertModelRoles([{ alias: "text-embed-private", role: "rerank" }]), /MODEL_ROLE/);

  const aliases = await runAsPrincipal(session([PERMISSIONS.PLAYGROUND_USE]), () => loadAliases());
  assert.ok(aliases.models.includes("chat-public"));
  assert.equal(aliases.models.includes("chat-private"), false);
  assert.equal(aliases.models.includes("chat-plan"), false);
});

test("the MCP builder drafts on internal routes, never a subscription, and is metered as a system call", async () => {
  const { draftMcpServer, setBuilderModel } = await import("@/lib/mcp/builder");
  const draft = JSON.stringify({
    name: "Pets",
    description: "Pet API",
    baseUrl: "https://api.pets.example/v1",
    internal: false,
    authType: "none",
    authHeader: "",
    notes: "",
    tools: [
      {
        name: "list_pets",
        title: "List pets",
        description: "Lists pets.",
        action: "read",
        method: "GET",
        path: "/pets",
        query: [],
        inputSchema: { type: "object", properties: {} },
      },
    ],
  });
  const input = { template: "custom", instruction: "Read pets", docs: "GET /pets lists every pet." };

  resetGateway();
  recordedPrisma.reset(settingsWith({ [BUILDER_MODEL_KEY]: "chat-private" }));
  gateway.reply = () => chatReply(draft);
  const result = await runAsPrincipal(platformAdmin, () => draftMcpServer(input));
  assert.deepEqual(result.tools.map((tool) => tool.name), ["list_pets"]);
  assert.ok(upstreamHosts().length > 0);
  assert.ok(upstreamHosts().every((host) => host === "private-chat.test"), upstreamHosts().join());
  assertSystemMetered("internal:mcp_builder", "chat-private");

  resetGateway();
  recordedPrisma.reset(settingsWith({ [BUILDER_MODEL_KEY]: "chat-plan" }));
  await assert.rejects(runAsPrincipal(platformAdmin, () => draftMcpServer(input)), /MCP_BUILDER_MODEL/);
  await assert.rejects(runAsPrincipal(platformAdmin, () => setBuilderModel("chat-plan")), /MCP_BUILDER_MODEL/);
  assert.deepEqual(gateway.upstream, []);
  assert.deepEqual(await runAsPrincipal(platformAdmin, () => setBuilderModel("CHAT-PRIVATE")), { model: "chat-private" });
});

test("Jev runs through an internal alias when no key is stored and maps provider failures", async () => {
  const { askJevStaged, jevRoute } = await import("@/lib/gateway/catalog/jev");
  const task: JevTask = {
    providerId: "p1",
    upstreamId: "llama-3.3-70b-versatile",
    kind: "openai_compat",
    vendor: "meta-llama",
    name: "Llama 3.3 70B",
    candidates: [{ alias: "llama-3.3-70b-instruct", label: "Llama 3.3 70B Instruct" }],
  };
  resetGateway();
  assert.deepEqual(await jevRoute({ enabled: true, model: "JEV-PRIVATE", api_key: "" }), { kind: "alias", alias: "jev-private" });
  assert.equal(await jevRoute({ enabled: true, model: "chat-plan", api_key: "" }), null);
  assert.equal(await jevRoute({ enabled: true, model: "no-such-model", api_key: "" }), null);
  assert.equal(await jevRoute({ enabled: false, model: "jev-private", api_key: "" }), null);
  assert.equal((await jevRoute({ enabled: true, model: "jev-private", api_key: "sk-or" }))?.kind, "key");

  gateway.reply = () =>
    Response.json({
      answers: {
        same_model: {
          type: "choice",
          choice: "llama-3.3-70b-instruct",
          probabilities: { "llama-3.3-70b-instruct": 0.97, none: 0.03 },
        },
      },
      usage: { input_tokens: 120, output_tokens: 0, cost: 0.000005 },
    });
  const answer = await askJevStaged({ kind: "alias", alias: "jev-private" }, task);
  assert.deepEqual(answer.verdict, { alias: "llama-3.3-70b-instruct", confidence: 0.97 });
  assert.equal(answer.cost, 0.000005);
  assert.equal(gateway.upstream[0]?.url, "https://private-jev.test/v1/systemone");
  assert.equal(gateway.upstream[0]?.body?.model, "jev-private");
  assertSystemMetered("internal:catalog", "jev-private");

  for (const [status, code] of [
    [401, "JEV_AUTH"],
    [403, "JEV_AUTH"],
    [402, "JEV_CREDITS"],
    [429, "JEV_RATE_LIMITED"],
  ] as const) {
    resetGateway();
    groups.set(`jev-${status}`, groupRow(`jev-${status}`, [{ id: `jev-${status}`, kind: "openai_compat", internal: true }]));
    gateway.reply = () => Response.json({ error: { message: "nope" } }, { status });
    await assert.rejects(askJevStaged({ kind: "alias", alias: `jev-${status}` }, task), new RegExp(`^Error: ${code}$`));
    groups.delete(`jev-${status}`);
  }

  resetGateway();
  await assert.rejects(askJevStaged({ kind: "alias", alias: "chat-plan" }, task), /JEV_FAILED/);
  assert.deepEqual(gateway.upstream, []);
});

test("saving Jev without a key needs a model alias routable on the internal surface", async () => {
  const { saveCatalogSettings } = await import("@/lib/settings/catalog");
  const input = (model: string) => ({
    catalog_auto_routes: true,
    catalog_min_confidence: 0.9,
    catalog_jev: { enabled: true, model, api_key: "", clear_api_key: false },
    vector_stores: { embedding_model: "", embedding_dimensions: 0, ocr_model: "", rerank_model: "" },
  });
  resetGateway();
  await assert.rejects(runAsPrincipal(platformAdmin, () => saveCatalogSettings(input("chat-plan"))), /JEV_KEY_REQUIRED/);
  await assert.rejects(runAsPrincipal(platformAdmin, () => saveCatalogSettings(input(""))), /JEV_KEY_REQUIRED/);
  const saved = await runAsPrincipal(platformAdmin, () => saveCatalogSettings(input("jev-private")));
  assert.equal(saved.settings.catalog_jev.model, "jev-private");
  assert.equal(saved.models.find((model) => model.alias === "jev-private")?.internal, true);
});

test("the semantic cache embeds with the admin-chosen model on internal routes for restricted keys", async () => {
  const { lookupChatCache } = await import("@/lib/gateway/cache/chat-cache");
  const body = { model: "chat-public", messages: [{ role: "user", content: "hello there" }] };
  const lookup = (principal: Principal, model: string) =>
    lookupChatCache({
      pool: "api",
      principal,
      model: "chat-public",
      body,
      ttlSeconds: 60,
      semantic: { enabled: true, model, threshold: 0.9 },
    });

  resetGateway();
  const first = await lookup(caller(), "text-embed-private");
  assert.ok(first.slot.semantic);
  assert.deepEqual(upstreamHosts(), ["private-embed.test"]);
  const usage = recordedPrisma.called("usageDaily", "upsert").map((call) => (call.args as { where: { slice: JsonMap } }).where.slice);
  assert.deepEqual(usage.map((slice) => [slice.keyId, slice.model]), [["key-1", "text-embed-private"]]);

  resetGateway();
  const governed = await lookup(caller({ dataRules: true }), "text-embed-private");
  assert.equal(governed.slot.semantic, null);
  assert.deepEqual(gateway.upstream, []);

  resetGateway();
  const plan = await lookup(caller(), "chat-plan");
  assert.equal(plan.slot.semantic, null);
  assert.deepEqual(gateway.upstream, []);

  resetGateway();
  const subscription = await lookupChatCache({
    pool: "subscription",
    principal: caller({ pool: "subscription" }),
    model: "chat-public",
    body,
    ttlSeconds: 60,
    semantic: { enabled: true, model: "text-embed-private", threshold: 0.9 },
  });
  assert.equal(subscription.slot.semantic, null);
  assert.deepEqual(gateway.upstream, []);
});

test("store models run on internal routes while caller-chosen RAG models stay on the API surface", async () => {
  const { embedTexts, forwardModelCall, rerankUsage, RERANK_PATH } = await import("@/lib/rag/models");
  const { allowCallerModels } = await import("@/lib/rag/api");
  const restricted = caller();

  resetGateway();
  const vectors = await embedTexts({ principal: restricted, endpoint: "/v1/vector_stores/vs_1/search", model: "text-embed-private", dimensions: 0, texts: ["hi"] });
  assert.equal(vectors.length, 1);
  assert.deepEqual(upstreamHosts(), ["private-embed.test"]);
  const metered = recordedPrisma.called("requestLog", "create").map((call) => (call.args as { data: JsonMap }).data);
  assert.deepEqual(metered.map((row) => [row.keyId, row.endpoint]), [["key-1", "/v1/vector_stores/vs_1/search"]]);

  resetGateway();
  await assert.rejects(
    embedTexts({ principal: caller({ dataRules: true }), endpoint: "/v1/x", model: "text-embed-private", dimensions: 0, texts: ["hi"] }),
    (err: unknown) => err instanceof GateError && err.status === 403 && err.code === "model_access_denied",
  );
  await assert.rejects(
    embedTexts({ principal: restricted, endpoint: "/v1/x", model: "chat-plan", dimensions: 0, texts: ["hi"] }),
    (err: unknown) => err instanceof GateError && err.status === 404,
  );
  assert.deepEqual(gateway.upstream, []);

  const open = caller({ models: [], key: keyView({ models: [] }) });
  const rerank = (principal: Principal, model: string, chosenBy: "caller" | "admin") =>
    forwardModelCall({
      principal,
      model,
      chosenBy,
      path: RERANK_PATH,
      body: { model, query: "q", documents: ["a"] },
      usage: rerankUsage,
    });
  resetGateway();
  await assert.rejects(rerank(open, "rerank-private", "caller"), (err: unknown) => err instanceof GateError && err.status === 404 && err.message === "no deployment for model");
  await assert.rejects(rerank(restricted, "rerank-public", "caller"), (err: unknown) => err instanceof GateError && err.status === 403);
  assert.deepEqual(gateway.upstream, []);
  assert.equal((await rerank(open, "rerank-public", "caller")).depId, "public-rerank");
  assert.equal((await rerank(restricted, "rerank-private", "admin")).depId, "private-rerank");
  assert.deepEqual(upstreamHosts(), ["public-rerank.test", "private-rerank.test"]);

  resetGateway();
  for (const [param, model] of [
    ["embedding_model", "text-embed-private"],
    ["rerank_model", "rerank-private"],
    ["ocr_model", "no-such-model"],
  ] as const) {
    await assert.rejects(
      allowCallerModels(open, { [param]: model }),
      (err: unknown) => err instanceof GateError && err.status === 404 && err.message === "no deployment for model" && err.param === param,
    );
  }
  await assert.rejects(
    allowCallerModels(open, { embedding_model: "chat-plan" }),
    (err: unknown) => err instanceof GateError && err.status === 404 && err.message.includes("/api/subscription/v1"),
  );
  await assert.rejects(
    allowCallerModels(restricted, { embedding_model: "text-embed-public" }),
    (err: unknown) => err instanceof GateError && err.status === 403,
  );
  await allowCallerModels(open, { embedding_model: "text-embed-public", rerank_model: "rerank-public", ocr_model: null });
});

test("model tests run as a system call for platform settings managers only", async () => {
  const { testFeatureModel } = await import("@/lib/models/feature-model-test");
  resetGateway();
  const ok = await runAsPrincipal(platformAdmin, () =>
    testFeatureModel({ feature: "knowledge", role: "embedding", model: "text-embed-private" }),
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.model, "text-embed-private");
  assert.equal(ok.status, 200);
  assert.deepEqual(upstreamHosts(), ["private-embed.test"]);
  assertSystemMetered("internal:test:knowledge", "text-embed-private");

  resetGateway();
  gateway.enterprise = { cache_semantic: { enabled: true, model: "text-embed-private", threshold: 0.9 } };
  const current = await runAsPrincipal(platformAdmin, () => testFeatureModel({ feature: "cache", role: "embedding" }));
  assert.equal(current.model, "text-embed-private");

  resetGateway();
  gateway.reply = () => Response.json({ error: { message: "bad key" } }, { status: 401 });
  const failed = await runAsPrincipal(platformAdmin, () =>
    testFeatureModel({ feature: "mcp_builder", role: "chat", model: "chat-public" }),
  );
  assert.deepEqual([failed.ok, failed.status, failed.error], [false, 401, "bad key"]);
  assertSystemMetered("internal:test:mcp_builder", "chat-public");

  resetGateway();
  await assert.rejects(
    runAsPrincipal(platformAdmin, () => testFeatureModel({ feature: "cache", role: "embedding", model: "chat-plan" })),
    /MODEL_NOT_ROUTABLE/,
  );
  await assert.rejects(
    runAsPrincipal(platformAdmin, () => testFeatureModel({ feature: "mcp_builder", role: "embedding", model: "chat-public" })),
    /VALIDATION/,
  );
  await assert.rejects(runAsPrincipal(platformAdmin, () => testFeatureModel({ feature: "cache", role: "embedding" })), /MODEL_REQUIRED/);
  await assert.rejects(
    runAsPrincipal(session([PERMISSIONS.SETTINGS_READ]), () => testFeatureModel({ feature: "cache", role: "embedding", model: "text-embed-private" })),
    /FORBIDDEN/,
  );
  await assert.rejects(
    runAsPrincipal(session([PERMISSIONS.SETTINGS_MANAGE], "org-1"), () =>
      testFeatureModel({ feature: "cache", role: "embedding", model: "text-embed-private" }),
    ),
    /FORBIDDEN|PLATFORM_ONLY/,
  );
  assert.deepEqual(gateway.upstream, []);
});

test("usage groups system rows as system and company scopes never include them", async () => {
  const { groupRequestHealth, groupSpend, SYSTEM_SLICE, systemSlice } = await import("@/lib/usage/usage-stats");
  const { spendScopeFor } = await import("@/lib/auth/scope");
  const slice = (change: Partial<UsageSlice>): UsageSlice => ({
    day: "2026-10-21",
    keyId: "",
    teamId: "",
    orgId: "",
    projectId: "",
    memberId: "",
    userId: "",
    model: "text-embed-private",
    requests: 1,
    errors: 0,
    rateLimited: 0,
    latencyMs: 10,
    promptTokens: 5,
    completionTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0.01,
    cacheSavings: 0,
    ...change,
  });
  const rows = [slice({}), slice({ userId: "user-1" }), slice({ orgId: "org-1", keyId: "key-1" })];
  assert.deepEqual(rows.map(systemSlice), [true, false, false]);
  assert.deepEqual(groupSpend(rows, "orgId").map((row) => row.name).sort(), ["org-1", SYSTEM_SLICE, "unassigned"].sort());
  assert.deepEqual(groupSpend(rows, "userId").map((row) => row.name).sort(), [SYSTEM_SLICE, "unassigned", "user-1"].sort());
  assert.deepEqual(groupRequestHealth(rows, "keyId").map((row) => row.name).sort(), ["key-1", SYSTEM_SLICE, "unassigned"].sort());

  const company = spendScopeFor({ company: "org-1", seesAll: true, userId: "u1" });
  const own = spendScopeFor({ company: null, seesAll: false, userId: "u1" });
  const visible = (scope: { orgId?: string; userId?: string }) =>
    rows.filter((row) => (scope.orgId === undefined || row.orgId === scope.orgId) && (scope.userId === undefined || row.userId === scope.userId));
  assert.equal(visible(company).some(systemSlice), false);
  assert.equal(visible(own).some(systemSlice), false);
  assert.equal(visible(spendScopeFor({ company: null, seesAll: true, userId: "u1" })).some(systemSlice), true);
});
