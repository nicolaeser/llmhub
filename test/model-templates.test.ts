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
    budget_duration: "",
    expires: "",
    allowed_ips: [],
    blocked: false,
    pii: null,
    log_content: true,
    created_at: "",
  };
  return { actor: "sk-hub-abc", key, teamId: "", orgId: "", userId: "", memberId: "", models };
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

test("modelPolicies follows every endpoint, fallback, and overflow", async () => {
  const { modelPolicies } = await import("@/lib/gateway/model-policy");
  const byAlias = new Map(modelPolicies(groups, providers).map((policy) => [policy.alias, policy]));

  const eu = byAlias.get("claude-eu");
  assert.deepEqual(
    { zdr: eu?.zdr, noTraining: eu?.noTraining, retention: eu?.retentionDays, regions: eu?.regions },
    { zdr: true, noTraining: true, retention: 0, regions: ["eu"] },
  );

  const mixed = byAlias.get("gpt-4o-mini");
  assert.equal(mixed?.zdr, false);
  assert.equal(mixed?.noTraining, true);
  assert.equal(mixed?.retentionDays, 30);
  assert.deepEqual(mixed?.regions, ["eu", "us"]);
  assert.deepEqual(mixed?.providerIds, ["us-30", "zdr-eu"]);

  const local = byAlias.get("local-llama");
  assert.equal(local?.custom, true);
  assert.equal(local?.zdr, false);
  assert.equal(local?.retentionDays, null);

  const fallback = byAlias.get("claude-fallback");
  assert.equal(fallback?.zdr, false);
  assert.deepEqual(fallback?.regions, ["eu", "us"]);

  const overflow = byAlias.get("claude-auto");
  assert.equal(overflow?.custom, true);
  assert.equal(overflow?.zdr, false);

  assert.equal(byAlias.get("mystery")?.retentionDays, null);
  assert.deepEqual(byAlias.get("mystery")?.regions, [""]);
  assert.equal(byAlias.get("empty")?.zdr, false);
  assert.equal(byAlias.get("empty")?.retentionDays, null);
});

test("templates combine provider, ZDR, retention, region, and name rules", async () => {
  const { modelPolicies, templateModels } = await import("@/lib/gateway/model-policy");
  const policies = modelPolicies(groups, providers);
  const match = (over: Partial<TemplateRules>) => templateModels(rules(over), policies).sort();

  assert.deepEqual(match({ zdrOnly: true }), ["claude-eu"]);
  assert.deepEqual(match({ regions: ["eu"] }), ["claude-eu"]);
  assert.deepEqual(match({ regions: ["eu", "us"] }), [
    "claude-eu",
    "claude-fallback",
    "gpt-4o",
    "gpt-4o-mini",
  ]);
  assert.deepEqual(match({ maxRetentionDays: 30 }), [
    "claude-eu",
    "claude-fallback",
    "gpt-4o",
    "gpt-4o-mini",
  ]);
  assert.deepEqual(match({ maxRetentionDays: 0 }), ["claude-eu"]);
  assert.deepEqual(match({ noTrainingOnly: true }), [
    "claude-eu",
    "claude-fallback",
    "gpt-4o",
    "gpt-4o-mini",
  ]);
  assert.deepEqual(match({ providerIds: ["us-30"] }), ["gpt-4o"]);
  assert.deepEqual(match({ providerIds: ["zdr-eu"] }), ["claude-eu"]);
  assert.deepEqual(match({ patterns: ["gpt-*"] }), ["gpt-4o", "gpt-4o-mini"]);
  assert.deepEqual(match({ patterns: ["gpt-*"], zdrOnly: true }), []);
  assert.deepEqual(match({ patterns: ["claude-*"], regions: ["eu"] }), ["claude-eu"]);
  assert.deepEqual(match({ zdrOnly: true, models: ["gpt-4o"] }), ["claude-eu", "gpt-4o"]);
  assert.deepEqual(match({ models: ["local-llama", "auto"] }), ["auto", "local-llama"]);
  assert.deepEqual(match({}), []);
});

test("resolveTemplates unions every template", async () => {
  const { modelPolicies, resolveTemplates } = await import("@/lib/gateway/model-policy");
  const policies = modelPolicies(groups, providers);
  assert.deepEqual(
    resolveTemplates([rules({ zdrOnly: true }), rules({ providerIds: ["us-30"] })], policies).sort(),
    ["claude-eu", "gpt-4o"],
  );
  assert.deepEqual(resolveTemplates([], policies), []);
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
