import assert from "node:assert/strict";
import test from "node:test";
import { overrideChanges, overrideMatches, sameSummary, type PolicyBook } from "@/app/(app)/guardrails/_components/policy-view";
import { newRule, nextRuleName, previewTerms, ruleMatches, upsertRule, withoutRule } from "@/app/(app)/guardrails/_components/rule-view";
import { defaultGuardrails } from "@/lib/gateway/safety/guardrails";
import type { GuardrailRule, PiiPolicy, PolicyOverrideView, PolicyTarget } from "@/types/guardrails";

const PII: PiiPolicy = { enabled: true, mode: "mask", output: false, entities: [], detector: "patterns", failure: "patterns" };

function target(scope: PolicyTarget["scope"], id: string, parents: Partial<PolicyTarget> = {}): PolicyTarget {
  return { scope, id, alias: id, orgId: "", teamId: "", projectId: "", path: [], ...parents };
}

function override(of: PolicyTarget, layer: Partial<PolicyOverrideView>): PolicyOverrideView {
  return { pii: null, injection: null, secrets: null, rules: null, updatedAt: "", target: of, ...layer };
}

function rule(name: string, patterns: string[]): GuardrailRule {
  return { ...newRule(name), patterns };
}

const acme = target("org", "acme", { orgId: "acme", alias: "Acme Robotics" });
const support = target("team", "support", { orgId: "acme", teamId: "support", alias: "Support", path: ["Acme Robotics"] });

test("overrideChanges compares each custom part with what the target would inherit", () => {
  const companyRow = override(acme, { pii: { ...PII, mode: "block" } });
  const teamRow = override(support, { pii: { ...PII, mode: "restore" }, rules: [rule("Codenames", ["falcon"])] });
  const book: PolicyBook = {
    platform: { pii: PII, guardrails: defaultGuardrails() },
    overrides: [companyRow, teamRow],
    targets: [acme, support],
  };

  const company = overrideChanges(book, companyRow);
  assert.deepEqual(
    company.map((change) => [change.section, change.from.state, change.to.state, change.source]),
    [["pii", "mask", "block", null]],
  );

  const team = overrideChanges(book, teamRow);
  assert.deepEqual(
    team.map((change) => [change.section, change.from.state, change.to.state, change.source?.id ?? null]),
    [
      ["pii", "block", "restore", "acme"],
      ["rules", "off", "on", null],
    ],
  );
});

test("sameSummary flags an override that repeats the inherited setting", () => {
  assert.equal(sameSummary({ section: "pii", state: "mask", count: 0 }, { section: "pii", state: "mask", count: 0 }), true);
  assert.equal(sameSummary({ section: "pii", state: "mask", count: 0 }, { section: "pii", state: "mask", count: 3 }), false);
});

test("overrideMatches searches the target name and its path", () => {
  const row = override(support, {});
  assert.equal(overrideMatches(row, ""), true);
  assert.equal(overrideMatches(row, "supp"), true);
  assert.equal(overrideMatches(row, "acme"), true);
  assert.equal(overrideMatches(row, "northwind"), false);
});

test("previewTerms trims, removes duplicates, shortens long terms, and counts the rest", () => {
  const long = "x".repeat(60);
  const preview = previewTerms({ patterns: [" alpha ", "alpha", "", "beta", long, "gamma", "delta"] });
  assert.equal(preview.shown.length, 3);
  assert.deepEqual(preview.shown.slice(0, 2), ["alpha", "beta"]);
  assert.equal(preview.shown[2]?.length, 40);
  assert.equal(preview.shown[2]?.endsWith("…"), true);
  assert.equal(preview.more, 2);
});

test("rule list helpers add, replace, remove, search, and name without collisions", () => {
  const first = rule("Rule 1", ["secret"]);
  const second = rule("Codenames", ["falcon", "osprey"]);
  const rules = upsertRule([first], second);
  assert.deepEqual(rules.map((item) => item.name), ["Rule 1", "Codenames"]);
  assert.deepEqual(upsertRule(rules, { ...first, name: "Renamed" }).map((item) => item.name), ["Renamed", "Codenames"]);
  assert.deepEqual(withoutRule(rules, first.id).map((item) => item.name), ["Codenames"]);
  assert.equal(ruleMatches(second, "osp"), true);
  assert.equal(ruleMatches(second, "code"), true);
  assert.equal(ruleMatches(second, "nothing"), false);
  assert.equal(nextRuleName([rule("Rule 2", ["a"]), rule("Rule 3", ["b"])], (n) => `Rule ${n}`), "Rule 4");
  assert.equal(nextRuleName([first], (n) => `Rule ${n}`), "Rule 2");
});
