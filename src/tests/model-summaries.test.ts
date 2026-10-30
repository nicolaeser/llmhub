import assert from "node:assert/strict";
import test from "node:test";
import { groupMatches, groupSummary, type SummaryRoute } from "@/app/(app)/models/_components/group-summary";
import { presetMatches, presetSummary } from "@/app/(app)/models/_components/preset-summary";
import type { ModelPolicy, ProviderPolicy, TemplateRules } from "@/types/model-templates";

const nameOf = (route: SummaryRoute) => route.providerId ?? route.kind;

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

const zdrEu: ProviderPolicy = { id: "zdr-eu", zdr: true, retentionDays: 0, region: "eu", noTraining: true };
const us30: ProviderPolicy = { id: "us-30", zdr: false, retentionDays: 30, region: "us", noTraining: false };

const policies: ModelPolicy[] = [
  { alias: "claude-eu", routes: [zdrEu] },
  { alias: "gpt-4o", routes: [us30] },
  { alias: "gpt-4o-mini", routes: [zdrEu, us30] },
];

const providers = [
  { id: "zdr-eu", name: "Anthropic EU" },
  { id: "us-30", name: "OpenAI" },
];

test("group summary counts named endpoints and keeps unique targets", () => {
  const summary = groupSummary(
    {
      deployments: [
        { providerId: "openai", kind: "openai", model: "gpt-4o" },
        { providerId: "openai", kind: "openai", model: "gpt-4o-2024" },
        { providerId: null, kind: "openai_compat", model: " " },
      ],
      strategy: "",
      fallbackGroups: ["claude", " claude ", ""],
      overflowGroup: " auto ",
      billingMode: "custom",
    },
    nameOf,
  );
  assert.equal(summary.spread, "several");
  assert.equal(summary.endpoints, 2);
  assert.deepEqual(summary.targets, ["openai"]);
  assert.equal(summary.strategy, "least_inflight");
  assert.deepEqual(summary.fallbacks, ["claude"]);
  assert.equal(summary.overflow, "auto");
  assert.equal(summary.billing, "custom");
});

test("group summary reports a group without endpoints", () => {
  const summary = groupSummary(
    { deployments: [], strategy: "priority", fallbackGroups: [], overflowGroup: "", billingMode: "nope" },
    nameOf,
  );
  assert.equal(summary.spread, "none");
  assert.equal(summary.billing, "routed");
  assert.equal(groupMatches({ alias: "gpt-4o", vendor: "openai", displayName: "" }, ["OpenAI API"], "api"), true);
  assert.equal(groupMatches({ alias: "gpt-4o", vendor: "openai", displayName: "" }, [], "claude"), false);
});

test("preset summary lists conditions, providers, and matching models", () => {
  const summary = presetSummary(
    rules({ zdrOnly: true, regions: ["eu"], providerIds: ["zdr-eu", "gone"], models: ["gpt-4o"] }),
    policies,
    providers,
  );
  assert.equal(summary.mode, "rules");
  assert.deepEqual(summary.providers, ["Anthropic EU"]);
  assert.equal(summary.removed, 1);
  assert.deepEqual(
    summary.conditions.map((condition) => condition.kind),
    ["zdr", "regions", "picked"],
  );
  assert.deepEqual([...summary.matches].sort(), ["claude-eu", "gpt-4o", "gpt-4o-mini"]);
});

test("preset summary separates empty and picked-only presets", () => {
  assert.equal(presetSummary(rules(), policies, providers).mode, "empty");
  assert.deepEqual(presetSummary(rules(), policies, providers).matches, []);
  const picked = presetSummary(rules({ models: ["gpt-4o"] }), policies, providers);
  assert.equal(picked.mode, "picked");
  assert.deepEqual(picked.matches, ["gpt-4o"]);
  assert.equal(presetMatches({ name: "EU", description: "" }, picked, "gpt-4o"), true);
  assert.equal(presetMatches({ name: "EU", description: "" }, picked, "claude"), false);
});
