import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import test from "node:test";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { permissions, PERMISSIONS, roleTemplates } from "@/lib/auth/permissions";
import type { AuthenticatedSession, Permission } from "@/types/auth";
import type { LiveFeed } from "@/types/live";
import type { AutoResetInput } from "@/types/resets";

const COMPANY_ID = "orgacme0001";

type Call = [string, () => Promise<unknown>];

function caller(
  granted: readonly Permission[],
  options: { isOwner?: boolean; workspaceOrgId?: string | null; orgId?: string | null } = {},
): AuthenticatedSession {
  return {
    error: false,
    sessionId: "s1",
    user: { id: "u1", username: "operator", email: "operator@example.com", orgId: options.orgId ?? null } as AuthenticatedSession["user"],
    isOwner: options.isOwner ?? false,
    role: null,
    permissions: [...granted],
    secondFactor: "TOTP",
    ipAddress: null,
    userAgent: null,
    workspaceOrgId: options.workspaceOrgId ?? null,
  };
}

async function providerChanges(): Promise<Call[]> {
  const connections = await import("@/lib/providers/connections");
  const routing = await import("@/lib/providers/account-routing");
  const { redeemProviderReset } = await import("@/lib/providers/resets");
  const { importAuthFiles, importSignInFile } = await import("@/lib/providers/auth-import");
  const { importCliProxyAuthFiles, listCliProxyAuthFiles } = await import("@/lib/providers/cliproxy-import");
  const { createSubAddLink, deleteSubAddLink } = await import("@/lib/providers/sub-add-links");
  const cliproxy = { url: "http://127.0.0.1:8317", key: "management-key" };
  return [
    ["createProvider", () => connections.createProvider({ name: "", kind: "openai", baseUrl: "", apiKey: "sk-test" })],
    ["updateProvider", () => connections.updateProvider({ id: "p1", name: "", baseUrl: "", apiKey: "", enabled: false })],
    ["deleteProvider", () => connections.deleteProvider("p1")],
    ["discoverProvider", () => connections.discoverProvider("p1")],
    ["importProviderModels", () => connections.importProviderModels({ id: "p1", models: [] })],
    ["startSignIn", () => connections.startSignIn("codex")],
    ["pollSignIn", () => connections.pollSignIn({ ticket: "ticket", interval: 5 })],
    ["completeSignIn", () => connections.completeSignIn({ ticket: "ticket", code: "code" })],
    ["saveAccountRouting", () => routing.saveAccountRouting({ kind: "codex", strategy: "smart" })],
    [
      "saveAutoReset",
      () => routing.saveAutoReset({ kind: "codex", enabled: true, percent: 5000, scope: "pool" } as AutoResetInput),
    ],
    ["loadAssignmentOptions", () => routing.loadAssignmentOptions()],
    ["saveAssignments", () => routing.saveAssignments({ providerId: "p1", restricted: true, targets: [] })],
    ["saveAntigravityConfig", () => routing.saveAntigravityConfig({ clientSecret: "secret" })],
    ["redeemProviderReset", () => redeemProviderReset({ id: "p1" })],
    ["importAuthFiles", () => importAuthFiles([{ name: "codex.json", content: "{}" }])],
    ["importSignInFile", () => importSignInFile("codex", "{}")],
    ["listCliProxyAuthFiles", () => listCliProxyAuthFiles(cliproxy)],
    ["importCliProxyAuthFiles", () => importCliProxyAuthFiles({ ...cliproxy, names: ["codex.json"], removeFromSource: true })],
    ["createSubAddLink", () => createSubAddLink({})],
    ["deleteSubAddLink", () => deleteSubAddLink("link-1")],
  ];
}

async function providerReads(): Promise<Call[]> {
  const connections = await import("@/lib/providers/connections");
  const routing = await import("@/lib/providers/account-routing");
  const { loadSubAddLinks } = await import("@/lib/providers/sub-add-links");
  const { loadProviderHealth } = await import("@/lib/gateway/routing/health-report");
  return [
    ["loadProviders", () => connections.loadProviders()],
    ["loadProviderLimits", () => connections.loadProviderLimits({ id: "p1", refresh: true })],
    ["loadSubscriptionLimits", () => connections.loadSubscriptionLimits({ refresh: true })],
    ["loadAccountRouting", () => routing.loadAccountRouting()],
    ["loadAntigravityConfig", () => routing.loadAntigravityConfig()],
    ["loadSubAddLinks", () => loadSubAddLinks()],
    ["loadProviderHealth", () => loadProviderHealth(15)],
  ];
}

async function modelChanges(): Promise<Call[]> {
  const groups = await import("@/lib/models/groups");
  const group = { alias: "chat", strategy: "", numRetries: 0, overflowGroup: "", fallbackGroups: [] };
  return [
    ["createModelGroup", () => groups.createModelGroup(group)],
    ["updateModelGroup", () => groups.updateModelGroup(group)],
    ["setModelGroupEnabled", () => groups.setModelGroupEnabled({ alias: "chat", enabled: false })],
    ["deleteModelGroup", () => groups.deleteModelGroup("chat")],
  ];
}

async function settingsReads(): Promise<Call[]> {
  const { loadGeneralSettings } = await import("@/lib/settings/general");
  const { loadSignInSettings } = await import("@/lib/settings/sign-in");
  const { loadStorageSettings } = await import("@/lib/settings/storage");
  const { loadLogging } = await import("@/lib/settings/logging-alerts");
  const { loadCache, loadCacheStats } = await import("@/lib/settings/caching");
  const { loadCatalogSettings } = await import("@/lib/settings/catalog");
  return [
    ["loadGeneralSettings", () => loadGeneralSettings()],
    ["loadSignInSettings", () => loadSignInSettings()],
    ["loadStorageSettings", () => loadStorageSettings()],
    ["loadLogging", () => loadLogging()],
    ["loadCache", () => loadCache()],
    ["loadCacheStats", () => loadCacheStats({ days: 7 })],
    ["loadCatalogSettings", () => loadCatalogSettings()],
  ];
}

async function settingsChanges(): Promise<Call[]> {
  const { saveGeneralSettings } = await import("@/lib/settings/general");
  const { checkOidcIssuer, issueScimToken, revokeScimToken, saveSignInSettings } = await import("@/lib/settings/sign-in");
  const { saveStorageSettings, testStorageSettings } = await import("@/lib/settings/storage");
  const { saveLogging } = await import("@/lib/settings/logging-alerts");
  const { saveCache } = await import("@/lib/settings/caching");
  const { saveCatalogSettings } = await import("@/lib/settings/catalog");
  return [
    ["saveGeneralSettings", () => saveGeneralSettings({})],
    ["saveSignInSettings", () => saveSignInSettings({})],
    ["checkOidcIssuer", () => checkOidcIssuer({ issuer: "https://login.example.com" })],
    ["issueScimToken", () => issueScimToken({ code: "123456" })],
    ["revokeScimToken", () => revokeScimToken({ code: "123456" })],
    ["saveStorageSettings", () => saveStorageSettings({})],
    ["testStorageSettings", () => testStorageSettings({})],
    ["saveLogging", () => saveLogging({} as Parameters<typeof saveLogging>[0])],
    ["saveCache", () => saveCache({} as Parameters<typeof saveCache>[0])],
    ["saveCatalogSettings", () => saveCatalogSettings({})],
  ];
}

async function assertRefused(principal: AuthenticatedSession, calls: Call[], code: RegExp) {
  for (const [name, call] of calls) {
    recordedPrisma.reset();
    await assert.rejects(runAsPrincipal(principal, call), code, name);
    assert.deepEqual(recordedPrisma.calls, [], name);
  }
}

test("provider, model, and settings services refuse the owner's company view before reading data", async () => {
  const companyView = caller(permissions, { isOwner: true, workspaceOrgId: COMPANY_ID });
  const calls = [
    ...(await providerChanges()),
    ...(await providerReads()),
    ...(await modelChanges()),
    ...(await settingsReads()),
    ...(await settingsChanges()),
  ];
  const { loadModels } = await import("@/lib/models/groups");
  await assertRefused(companyView, [...calls, ["loadModels", () => loadModels()]], /PLATFORM_ONLY/);
});

test("a company user with provider permissions on the role still cannot reach provider services", async () => {
  const companyUser = caller([PERMISSIONS.PROVIDERS_READ, PERMISSIONS.PROVIDERS_MANAGE], { orgId: COMPANY_ID });
  await assertRefused(companyUser, [...(await providerReads()), ...(await providerChanges())], /PLATFORM_ONLY/);
});

test("the viewer template is refused every provider, model, and settings change before reading data", async () => {
  const viewer = caller(roleTemplates.viewer);
  await assertRefused(
    viewer,
    [...(await providerChanges()), ...(await modelChanges()), ...(await settingsChanges())],
    /FORBIDDEN/,
  );
});

test("a role with only providers:read reads providers but changes nothing", async () => {
  const reader = caller([PERMISSIONS.PROVIDERS_READ]);
  await assertRefused(reader, [...(await providerChanges()), ...(await modelChanges())], /FORBIDDEN/);
  const { loadProviders } = await import("@/lib/providers/connections");
  recordedPrisma.reset();
  const listed = await runAsPrincipal(reader, () => loadProviders());
  assert.equal(listed.canManage, false);
  assert.deepEqual(listed.connected, []);
});

test("the operator template manages providers and models but changes no settings", async () => {
  const operator = caller(roleTemplates.operator);
  await assertRefused(operator, await settingsChanges(), /FORBIDDEN/);
  const { loadProviders } = await import("@/lib/providers/connections");
  const { loadModels } = await import("@/lib/models/groups");
  recordedPrisma.reset();
  assert.equal((await runAsPrincipal(operator, () => loadProviders())).canManage, true);
  assert.equal((await runAsPrincipal(operator, () => loadModels())).canManage, true);
  assert.equal((await runAsPrincipal(caller(roleTemplates.finance), () => loadModels())).canManage, false);
});

test("provider lists never carry API keys or sign-in tokens", async () => {
  const { loadProviders } = await import("@/lib/providers/connections");
  recordedPrisma.reset({
    providerConnection: {
      findMany: () => [
        {
          id: "p1",
          name: "OpenAI",
          kind: "openai",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sealed-api-key",
          enabled: true,
          restricted: false,
          zdr: false,
          retentionDays: 30,
          region: "",
          noTraining: false,
          discovered: [],
          assignments: [],
          login: { account: "ops@example.com", plan: "pro", status: "active", tokens: "sealed-tokens" },
          subAdd: null,
        },
      ],
    },
  });
  const { connected } = await runAsPrincipal(caller([PERMISSIONS.PROVIDERS_READ]), () => loadProviders());
  const text = JSON.stringify(connected);
  assert.equal(connected[0].hasApiKey, true);
  assert.equal(text.includes("sealed-api-key"), false);
  assert.equal(text.includes("sealed-tokens"), false);
  assert.deepEqual(connected[0].signIn, { account: "ops@example.com", plan: "pro", status: "active" });
});

test("model readers without pricing access get no purchase costs", async () => {
  const { loadModels } = await import("@/lib/models/groups");
  const group = {
    alias: "chat",
    enabled: true,
    vendor: "",
    displayName: "",
    autoRoutes: null,
    variants: [],
    strategy: "least_inflight",
    billingMode: "routed",
    priceInput: 0,
    priceOutput: 0,
    priceTimeZone: "UTC",
    overflowGroup: "",
    numRetries: 0,
    fallbackGroups: [],
    priceWindows: [],
    deployments: [
      {
        id: "d1",
        groupAlias: "chat",
        kind: "openai",
        baseUrl: "",
        model: "gpt-test",
        weight: 1,
        costInput: 0.004,
        costOutput: 0.012,
        providerId: "p1",
      },
    ],
  };
  const provider = {
    id: "p1",
    name: "OpenAI",
    kind: "openai",
    baseUrl: "",
    apiKey: "sealed-api-key",
    discovered: [{ id: "gpt-test", cost_input_per_1k: 0.004, cost_output_per_1k: 0.012 }],
  };
  const handlers = {
    modelGroup: { findMany: () => [group] },
    providerConnection: { findMany: () => [provider] },
  };
  recordedPrisma.reset(handlers);
  const reader = await runAsPrincipal(caller([PERMISSIONS.MODELS_READ]), () => loadModels());
  assert.equal(reader.canManage, false);
  assert.deepEqual(
    reader.groups[0]?.deployments.map((deployment) => [deployment.costInput, deployment.costOutput]),
    [[0, 0]],
  );
  assert.deepEqual(reader.providers[0]?.discovered, []);
  assert.equal(JSON.stringify(reader).includes("sealed-api-key"), false);
  recordedPrisma.reset(handlers);
  const finance = await runAsPrincipal(caller(roleTemplates.finance), () => loadModels());
  assert.deepEqual(
    finance.groups[0]?.deployments.map((deployment) => [deployment.costInput, deployment.costOutput]),
    [[0.004, 0.012]],
  );
  assert.equal(finance.providers[0]?.discovered?.length, 1);
});

test("settings readers see only the origin of alert webhook URLs", async () => {
  const { loadLogging, visibleWebhookUrl } = await import("@/lib/settings/logging-alerts");
  const url = "https://hooks.slack.com/services/T000/B000/secretpart";
  assert.equal(visibleWebhookUrl(url, true), url);
  assert.equal(visibleWebhookUrl(url, false), "https://hooks.slack.com");
  assert.equal(visibleWebhookUrl("not a url", false), "");
  const stored = {
    alert_webhooks: [{ id: "hook-1", url, secret: "", format: "slack", events: ["budget_threshold"] }],
  };
  recordedPrisma.reset({
    setting: { findUnique: () => ({ key: "enterprise", value: JSON.stringify(stored) }) },
  });
  const reader = await runAsPrincipal(caller([PERMISSIONS.SETTINGS_READ]), () => loadLogging());
  assert.equal(reader.canManage, false);
  assert.equal(reader.alertWebhooks[0]?.url, "https://hooks.slack.com");
  const manager = await runAsPrincipal(caller([PERMISSIONS.SETTINGS_READ, PERMISSIONS.SETTINGS_MANAGE]), () => loadLogging());
  assert.equal(manager.alertWebhooks[0]?.url, url);
});

test("catalog actions answer the company view and read-only callers with a refusal", async () => {
  const actions = await import("@/app/(app)/models/_action");
  const companyView = caller(permissions, { isOwner: true, workspaceOrgId: COMPANY_ID });
  recordedPrisma.reset();
  assert.deepEqual(await runAsPrincipal(companyView, () => actions.loadCatalogAction()), {
    ok: false,
    error: "PLATFORM_ONLY",
    message: "PLATFORM_ONLY",
  });
  const reader = caller([PERMISSIONS.MODELS_READ]);
  const refused = [
    () => actions.refreshCatalogAction(),
    () => actions.setCatalogGroupActiveAction({ alias: "chat", active: true }),
    () => actions.setCatalogGroupAutoRoutesAction({ alias: "chat", autoRoutes: null }),
    () => actions.setCatalogEntryActiveAction({ providerId: "p1", upstreamId: "gpt", active: true }),
    () => actions.assignCatalogEntryAction({ providerId: "p1", upstreamId: "gpt", alias: "chat" }),
  ];
  for (const call of refused) {
    recordedPrisma.reset();
    const result = await runAsPrincipal(reader, call);
    assert.equal("error" in result ? result.error : "", "FORBIDDEN");
    assert.deepEqual(recordedPrisma.calls, []);
  }
});

test("the live limits topic is never subscribed in a company scope", async () => {
  const { LIMITS_FEED } = await import("@/lib/providers/limits-feed");
  const { liveAccess, liveStream } = await import("@/lib/updates/live-stream");
  assert.equal(LIMITS_FEED.platformOnly, true);
  const loads: unknown[] = [];
  const limits: LiveFeed<number> = {
    topic: "limits",
    permission: PERMISSIONS.PROVIDERS_READ,
    platformOnly: true,
    pollMs: 60_000,
    minGapMs: 0,
    scopeKey: (scope) => scope.orgId ?? "",
    async load(scope) {
      loads.push(scope);
      return 1;
    },
    full: (value) => ({ value }),
    change: () => null,
  };
  const abort = new AbortController();
  const reader = liveStream({
    sessionId: "session-gateway-permissions",
    access: liveAccess([...permissions], { orgId: COMPANY_ID }),
    topics: ["limits"],
    signal: abort.signal,
    heartbeatMs: 10,
    loadSnapshot: async () => ({
      build: { version: "development", startedAt: "2026-10-20T09:00:00.000Z" },
      updater: null,
      updating: false,
    }),
    feeds: { limits },
  }).getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("event: ping")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value);
  }
  abort.abort();
  while (!(await reader.read()).done);
  assert.doesNotMatch(text, /event: limits/);
  assert.deepEqual(loads, []);
});
