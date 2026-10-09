import assert from "node:assert/strict";
import test from "node:test";
import type { PolicyGroup, ProviderPolicy, TemplateRules } from "@/types/model-templates";
import type { Principal, VirtualKeyView } from "@/types/gateway";

const providers: ProviderPolicy[] = [
  { id: "zdr-eu", zdr: true, retentionDays: null, region: "eu", noTraining: false },
  { id: "us-30", zdr: false, retentionDays: 30, region: "us", noTraining: true },
  { id: "unknown", zdr: false, retentionDays: null, region: "", noTraining: false },
];

function group(alias: string, providerIds: (string | null)[], extra: Partial<PolicyGroup> = {}): PolicyGroup {
  return { alias, providerIds, overflowGroup: "", fallbackGroups: [], ...extra };
}

const groups: PolicyGroup[] = [
  group("claude-eu", ["zdr-eu"]),
  group("gpt-4o", ["us-30"]),
  group("gpt-4o-mini", ["zdr-eu", "us-30"]),
  group("local-llama", [null]),
  group("claude-fallback", ["zdr-eu"], { fallbackGroups: ["gpt-4o"] }),
  group("claude-auto", ["zdr-eu"], { overflowGroup: "auto" }),
  group("mystery", ["unknown"]),
  group("empty", []),
];

function rules(over: Partial<TemplateRules> = {}): TemplateRules {
  return {
    models: [],
    patterns: [],
    providerIds: [],
    regions: [],
    zdrOnly: false,
    noTrainingOnly: false,
    maxRetentionDays: null,
    ...over,
  };
}

function keyPrincipal(models: string[], templates: string[]): Principal {
  const key: VirtualKeyView = {
    token_id: "k1",
    key_name: "sk-hub-abc",
    key_alias: "test",
    user_id: "",
    team_id: "",
    org_id: "",
    project_id: "",
    member_id: "",
    models,
    templates,
    max_budget: 0,
    spend: 0,
    rpm_limit: 0,
    tpm_limit: 0,
    max_request_cost: 0,
    budget_duration: "",
    expires: "",
    allowed_ips: [],
    blocked: false,
    pii: null,
    log_content: true,
    created_at: "",
  };
  return { actor: "sk-hub-abc", key, teamId: "", orgId: "", userId: "", memberId: "", models, routeLimits: {} };
}

test("patternMatches supports * wildcards case-insensitively", async () => {
  const { patternMatches } = await import("@/lib/gateway/model-policy");
  assert.equal(patternMatches("claude-*", "claude-3-5-sonnet"), true);
  assert.equal(patternMatches("CLAUDE-*", "claude-opus"), true);
  assert.equal(patternMatches("*mini*", "gpt-4o-mini-2024"), true);
  assert.equal(patternMatches("gpt-4o", "gpt-4o"), true);
  assert.equal(patternMatches("gpt-4o", "gpt-4o-mini"), false);
  assert.equal(patternMatches("*-eu", "claude-eu"), true);
  assert.equal(patternMatches("a*b*c", "axxbyyc"), true);
  assert.equal(patternMatches("a*b*c", "axxbyy"), false);
  assert.equal(patternMatches("", "anything"), false);
});

test("modelPolicies lists every route behind an alias, including fallback and overflow", async () => {
  const { modelPolicies } = await import("@/lib/gateway/model-policy");
  const byAlias = new Map(modelPolicies(groups, providers).map((policy) => [policy.alias, policy]));
  const ids = (alias: string) => byAlias.get(alias)?.routes.map((route) => route?.id ?? null);

  assert.deepEqual(ids("claude-eu"), ["zdr-eu"]);
  assert.deepEqual(ids("gpt-4o-mini"), ["zdr-eu", "us-30"]);
  assert.deepEqual(ids("local-llama"), [null]);
  assert.deepEqual(ids("claude-fallback"), ["zdr-eu", "us-30"]);
  assert.deepEqual(ids("mystery"), ["unknown"]);
  assert.deepEqual(ids("empty"), []);
  const overflow = ids("claude-auto") ?? [];
  assert.ok(overflow.includes("zdr-eu") && overflow.includes("us-30") && overflow.includes(null));
});

test("routeAllowed applies provider, ZDR, training, retention, and region rules to one route", async () => {
  const { routeAllowed } = await import("@/lib/gateway/model-policy");
  const [zdrEu, us30, unknown] = providers;
  const rule = (over: Partial<TemplateRules>) => ({ ...rules(over) });
  assert.equal(routeAllowed(rule({ zdrOnly: true }), zdrEu!), true);
  assert.equal(routeAllowed(rule({ zdrOnly: true }), us30!), false);
  assert.equal(routeAllowed(rule({ noTrainingOnly: true }), zdrEu!), true);
  assert.equal(routeAllowed(rule({ noTrainingOnly: true }), unknown!), false);
  assert.equal(routeAllowed(rule({ maxRetentionDays: 0 }), zdrEu!), true);
  assert.equal(routeAllowed(rule({ maxRetentionDays: 29 }), us30!), false);
  assert.equal(routeAllowed(rule({ maxRetentionDays: 365 }), unknown!), false);
  assert.equal(routeAllowed(rule({ regions: ["us"] }), us30!), true);
  assert.equal(routeAllowed(rule({ regions: ["eu"] }), unknown!), false);
  assert.equal(routeAllowed(rule({ providerIds: ["us-30"] }), us30!), true);
  assert.equal(routeAllowed(rule({ providerIds: ["us-30"] }), zdrEu!), false);
  assert.equal(routeAllowed(rule({ zdrOnly: true }), null), false);
});

test("templates match a model when at least one route meets every rule", async () => {
  const { modelPolicies, templateModels } = await import("@/lib/gateway/model-policy");
  const policies = modelPolicies(groups, providers);
  const match = (over: Partial<TemplateRules>) => templateModels(rules(over), policies).sort();
  const viaZdrEu = ["claude-auto", "claude-eu", "claude-fallback", "gpt-4o-mini"];
  const viaEither = ["claude-auto", "claude-eu", "claude-fallback", "gpt-4o", "gpt-4o-mini"];

  assert.deepEqual(match({ zdrOnly: true }), viaZdrEu);
  assert.deepEqual(match({ regions: ["eu"] }), viaZdrEu);
  assert.deepEqual(match({ regions: ["eu", "us"] }), viaEither);
  assert.deepEqual(match({ maxRetentionDays: 30 }), viaEither);
  assert.deepEqual(match({ maxRetentionDays: 0 }), viaZdrEu);
  assert.deepEqual(match({ noTrainingOnly: true }), viaEither);
  assert.deepEqual(match({ providerIds: ["us-30"] }), ["claude-auto", "claude-fallback", "gpt-4o", "gpt-4o-mini"]);
  assert.deepEqual(match({ providerIds: ["zdr-eu"] }), viaZdrEu);
  assert.deepEqual(match({ patterns: ["gpt-*"] }), ["gpt-4o", "gpt-4o-mini"]);
  assert.deepEqual(match({ patterns: ["gpt-*"], zdrOnly: true }), ["gpt-4o-mini"]);
  assert.deepEqual(match({ patterns: ["claude-*"], regions: ["eu"] }), ["claude-auto", "claude-eu", "claude-fallback"]);
  assert.deepEqual(match({ zdrOnly: true, models: ["gpt-4o"] }), viaEither);
  assert.deepEqual(match({ models: ["local-llama", "auto"] }), ["auto", "local-llama"]);
  assert.deepEqual(match({ regions: ["eu"], patterns: ["mystery", "local-*", "empty"] }), []);
  assert.deepEqual(match({}), []);
});

test("resolveAccess limits routes only for aliases granted by data rules", async () => {
  const { modelPolicies, resolveAccess } = await import("@/lib/gateway/model-policy");
  const policies = modelPolicies(groups, providers);
  const zdr = rules({ zdrOnly: true });
  const us = rules({ providerIds: ["us-30"] });

  const access = resolveAccess([], [zdr, us], policies);
  assert.deepEqual(access.models.sort(), ["claude-auto", "claude-eu", "claude-fallback", "gpt-4o", "gpt-4o-mini"]);
  assert.equal(access.limits["gpt-4o-mini"]?.length, 2);
  assert.equal(access.limits["claude-eu"]?.length, 1);
  assert.equal(access.limits["gpt-4o"]?.[0]?.providerIds[0], "us-30");

  assert.equal("claude-eu" in resolveAccess(["claude-eu"], [zdr], policies).limits, false);
  assert.deepEqual(resolveAccess(["*"], [zdr], policies).limits, {});
  const always = resolveAccess([], [rules({ zdrOnly: true, models: ["gpt-4o-mini"] })], policies);
  assert.equal("gpt-4o-mini" in always.limits, false);
  assert.ok(always.models.includes("claude-eu"));
  const named = resolveAccess([], [rules({ patterns: ["gpt-*"] }), zdr], policies);
  assert.equal("gpt-4o-mini" in named.limits, false);
  assert.equal("claude-eu" in named.limits, true);
  assert.deepEqual(resolveAccess([], [], policies), { models: [], limits: {} });
});

test("templateRulesOf drops malformed JSON entries and unknown regions", async () => {
  const { templateRulesOf } = await import("@/lib/gateway/model-policy");
  assert.deepEqual(
    templateRulesOf({
      models: ["a", 3, "", null],
      patterns: "claude-*",
      providerIds: ["p1"],
      regions: ["eu", "mars"],
      zdrOnly: true,
      noTrainingOnly: false,
      maxRetentionDays: 7,
    }),
    rules({ models: ["a"], providerIds: ["p1"], regions: ["eu"], zdrOnly: true, maxRetentionDays: 7 }),
  );
});

test("keys bound to templates fail closed when nothing resolves", async () => {
  const { modelPermitted } = await import("@/lib/gateway/gate");
  assert.equal(modelPermitted(keyPrincipal([], []), "gpt-4o"), true);
  assert.equal(modelPermitted(keyPrincipal([], ["template"]), "gpt-4o"), false);
  assert.equal(modelPermitted(keyPrincipal(["claude-eu"], ["template"]), "claude-eu"), true);
  assert.equal(modelPermitted(keyPrincipal(["claude-eu"], ["template"]), "gpt-4o"), false);
  assert.equal(modelPermitted(keyPrincipal(["*"], []), "gpt-4o"), true);
});

test("model names are matched case-insensitively and normalized to lowercase", async () => {
  const { modelChain, modelOf, modelPermitted } = await import("@/lib/gateway/gate");
  const { createKeySchema } = await import("@/schemas/keys");
  const { createTemplateSchema } = await import("@/schemas/model-templates");
  const { adminSettingsSchema } = await import("@/schemas/settings");
  assert.equal(modelOf({ model: "  Gemma-3-27B " }), "gemma-3-27b");
  assert.equal(modelOf({}, "fallback"), "fallback");
  const principal = keyPrincipal(["gemma-3-27b", "llama-70b"], ["template"]);
  assert.equal(modelPermitted(principal, "GEMMA-3-27b"), true);
  assert.deepEqual(modelChain(principal, modelOf({ model: "Gemma-3-27B" }), { fallbacks: ["LLAMA-70B"] }), [
    "gemma-3-27b",
    "llama-70b",
  ]);
  assert.deepEqual(createKeySchema.parse({ alias: "ci", models: ["Gemma-3-27B"] }).models, ["gemma-3-27b"]);
  assert.deepEqual(createTemplateSchema.parse({ name: "t", models: ["Llama-70B"] }).models, ["llama-70b"]);
  assert.equal(adminSettingsSchema.shape.assistant_model.parse(" Gemma-3-27B "), "gemma-3-27b");
});

test("request fallbacks must be allowed for the key", async () => {
  const { modelChain } = await import("@/lib/gateway/gate");
  const { GateError } = await import("@/lib/gateway/errors");
  const principal = keyPrincipal(["claude-eu", "claude-fallback"], ["template"]);
  assert.deepEqual(
    modelChain(principal, "claude-eu", { fallbacks: ["claude-fallback"] }),
    ["claude-eu", "claude-fallback"],
  );
  assert.throws(
    () => modelChain(principal, "claude-eu", { fallbacks: ["gpt-4o"] }),
    (err: unknown) => err instanceof GateError && err.status === 403 && err.code === "model_access_denied",
  );
  assert.throws(
    () => modelChain(principal, "claude-eu", { fallback: { model: "gpt-4o" } }),
    (err: unknown) => err instanceof GateError && err.status === 403,
  );
  assert.deepEqual(modelChain(keyPrincipal([], []), "any", { fallbacks: ["other"] }), ["any", "other"]);
});

test("no gateway route resolves model chains without the key check", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const root = path.join(import.meta.dirname, "..", "src");
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(".ts"));
  const offenders: string[] = [];
  for (const file of files) {
    if (file.endsWith(path.join("gateway", "runtime.ts")) || file.endsWith(path.join("gateway", "gate.ts"))) continue;
    if (/\baliasChain\b/.test(await readFile(path.join(root, file), "utf8"))) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});
