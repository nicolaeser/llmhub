import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { COMPANY_PERMISSIONS, effectivePermissions, roleTemplates } from "@/lib/auth/permissions";
import {
  applyMarkup,
  marginShare,
  markupColumns,
  markupRuleOf,
  markupScopeOf,
  pickMarkup,
} from "@/lib/gateway/markup-policy";
import { chargebackRows, groupSpend } from "@/lib/gateway/usage-stats";
import { serializeUsage } from "@/lib/management/serialize";
import { markupSchema } from "@/schemas/pricing";
import { markupCreateSchema, markupUpdateSchema } from "@/schemas/management";
import type { UsageSlice } from "@/types/gateway";
import type { MarkupRule, MarkupTarget } from "@/types/pricing";

const rule = (id: string, scope: MarkupRule["scope"], targetId: string, model: string, percent: number): MarkupRule => ({
  id,
  scope,
  targetId,
  model,
  percent,
});

const rules = [
  rule("global", "all", "", "", 10),
  rule("global-claude", "all", "", "claude-*", 30),
  rule("acme", "org", "o1", "", 15),
  rule("acme-claude", "org", "o1", "claude-*", 12),
  rule("acme-opus", "org", "o1", "claude-opus-5-5", 8),
  rule("acme-it", "team", "t1", "", 5),
  rule("chatbot", "project", "p1", "", 0),
];

const target = (patch: Partial<MarkupTarget>): MarkupTarget => ({
  orgId: "",
  teamId: "",
  projectId: "",
  model: "gpt-5",
  ...patch,
});

test("the most specific tenancy level wins before the model rule", () => {
  assert.equal(pickMarkup(rules, target({}))?.id, "global");
  assert.equal(pickMarkup(rules, target({ model: "claude-sonnet-5" }))?.id, "global-claude");
  assert.equal(pickMarkup(rules, target({ orgId: "o1", model: "claude-sonnet-5" }))?.id, "acme-claude");
  assert.equal(pickMarkup(rules, target({ orgId: "o1", teamId: "t1", model: "claude-sonnet-5" }))?.id, "acme-it");
  assert.equal(pickMarkup(rules, target({ orgId: "o1", teamId: "t1", projectId: "p1" }))?.id, "chatbot");
  assert.equal(pickMarkup(rules, target({ orgId: "o2" }))?.id, "global");
});

test("an exact model beats a pattern and a pattern beats all models on one level", () => {
  assert.equal(pickMarkup(rules, target({ orgId: "o1", model: "Claude-Opus-5-5" }))?.id, "acme-opus");
  assert.equal(pickMarkup(rules, target({ orgId: "o1", model: "claude-haiku-4-5" }))?.id, "acme-claude");
  assert.equal(pickMarkup(rules, target({ orgId: "o1", model: "gpt-5" }))?.id, "acme");
  const patterns = [rule("short", "all", "", "claude-*", 1), rule("long", "all", "", "claude-opus-*", 2)];
  assert.equal(pickMarkup(patterns, target({ model: "claude-opus-5-5" }))?.id, "long");
});

test("no rule leaves the price unchanged and empty tenancy never matches a scoped rule", () => {
  const scoped = [rule("acme", "org", "o1", "", 15), rule("broken", "team", "", "", 50)];
  assert.equal(pickMarkup(scoped, target({})), null);
  assert.equal(pickMarkup([], target({ orgId: "o1" })), null);
});

test("markups and discounts scale the billed price and never go below zero", () => {
  assert.equal(applyMarkup(100, 15), 115);
  assert.equal(applyMarkup(100, -20), 80);
  assert.equal(applyMarkup(100, -100), 0);
  assert.equal(applyMarkup(100, -150), 0);
  assert.equal(marginShare(80, 100), 0.2);
  assert.equal(marginShare(0, 0), null);
});

test("scope columns round-trip and each rule names exactly one holder", () => {
  for (const scope of ["all", "org", "team", "project"] as const) {
    const id = scope === "all" ? "" : "x1";
    const columns = markupColumns(scope, id);
    assert.deepEqual(markupScopeOf(columns), { scope, targetId: id });
    assert.ok(Object.values(columns).filter(Boolean).length <= 1, scope);
  }
  assert.deepEqual(
    markupRuleOf({ id: "m1", orgId: null, teamId: "t1", projectId: null, model: "gpt-*", percent: 12.5 }),
    rule("m1", "team", "t1", "gpt-*", 12.5),
  );
});

test("markup input normalizes models and requires a target outside all customers", () => {
  const parsed = markupSchema.parse({ scope: "org", targetId: "o1", model: "  Claude-* ", percent: 12.345678 });
  assert.equal(parsed.model, "claude-*");
  assert.equal(parsed.percent, 12.3457);
  assert.equal(markupSchema.safeParse({ scope: "org", targetId: "", percent: 10 }).success, false);
  assert.equal(markupSchema.safeParse({ scope: "all", targetId: "o1", percent: 10 }).success, false);
  assert.equal(markupSchema.safeParse({ scope: "all", percent: -101 }).success, false);
  assert.equal(markupSchema.safeParse({ scope: "all", percent: 1001 }).success, false);
  assert.equal(markupCreateSchema.safeParse({ scope: "org", target_id: "o1", percent: 5, extra: 1 }).success, false);
  assert.equal(markupUpdateSchema.safeParse({ percent: -5 }).success, true);
});

test("company users never see purchase cost or manage markups", () => {
  for (const permission of ["pricing:read", "pricing:manage"] as const) {
    assert.equal((COMPANY_PERMISSIONS as readonly string[]).includes(permission), false, permission);
    assert.equal(
      effectivePermissions({ isOwner: false, rolePermissions: [...roleTemplates.admin], orgId: "o1" }).includes(permission),
      false,
      permission,
    );
    assert.equal(roleTemplates.viewer.includes(permission), false, permission);
    assert.equal(roleTemplates.finance.includes(permission), true, permission);
  }
});

const slice = (row: Partial<UsageSlice>): UsageSlice => ({
  day: "2026-10-09",
  keyId: "",
  teamId: "",
  orgId: "",
  projectId: "",
  memberId: "",
  userId: "",
  model: "gpt-5",
  requests: 1,
  errors: 0,
  rateLimited: 0,
  latencyMs: 0,
  promptTokens: 10,
  completionTokens: 5,
  cost: 0,
  ...row,
});

test("purchase cost rolls up only when it was loaded", () => {
  const priced = [
    slice({ orgId: "o1", cost: 1.15, purchaseCost: 1 }),
    slice({ orgId: "o1", cost: 2.3, purchaseCost: 2 }),
  ];
  const [org] = groupSpend(priced, "orgId");
  assert.ok(Math.abs((org?.purchase ?? 0) - 3) < 1e-9);
  assert.ok(Math.abs((org?.spend ?? 0) - 3.45) < 1e-9);
  assert.equal(chargebackRows(priced)[0]?.purchase !== undefined, true);
  const blind = [slice({ orgId: "o1", cost: 1.15 })];
  assert.equal("purchase" in (groupSpend(blind, "orgId")[0] ?? {}), false);
  assert.equal("purchase" in (chargebackRows(blind)[0] ?? {}), false);
});

const usage = {
  days: 7,
  model: "",
  teamId: "",
  orgId: "",
  projectId: "",
  memberId: "",
  keyId: "",
  userId: "",
  spend: 12,
  tokens: 10,
  count: 3,
  errors: 0,
  rate429: 0,
  latency: 1,
  p95Latency: 1,
  daily: [],
  byModel: [],
  byTeam: [],
  byOrg: [],
  byProject: [],
  byMember: [],
  byKey: [],
  byUser: [],
};

test("management usage shows purchase cost and margin only when present", () => {
  const priced = serializeUsage({
    ...usage,
    purchase: 10,
    byOrg: [{ name: "o1", spend: 12, purchase: 10, prompt: 1, completion: 1 }],
    chargeback: [{ name: "o1/-/-/-/-/-/gpt-5", spend: 12, purchase: 10, prompt: 1, completion: 1 }],
  });
  assert.equal(priced.totals.purchase_cost, 10);
  assert.equal(priced.totals.margin, 2);
  assert.equal(priced.by_org[0]?.margin, 2);
  assert.equal(priced.chargeback[0]?.purchase_cost, 10);
  const blind = serializeUsage({
    ...usage,
    purchase: null,
    chargeback: [{ name: "o1/-/-/-/-/-/gpt-5", spend: 12, prompt: 1, completion: 1 }],
  });
  assert.equal("purchase_cost" in blind.totals, false);
  assert.equal("margin" in (blind.chargeback[0] ?? {}), false);
});

test("recordUsage bills the marked-up price and stores the purchase cost beside it", async () => {
  const source = await readFile(new URL("../src/lib/gateway/billing.ts", import.meta.url), "utf8");
  assert.match(source, /const purchaseCost = costOf\(input\.deployment, usage\);/);
  assert.match(source, /const listed = costOf\(input\.deployment, usage, billing\);/);
  assert.match(source, /markupPercent\(\{ orgId, teamId, projectId, model: input\.model \}\)/);
  assert.match(source, /purchaseCost: \{ increment: purchaseCost \}/);
});

test("usage loads purchase cost only with the margins permission", async () => {
  const source = await readFile(new URL("../src/app/(app)/_action.ts", import.meta.url), "utf8");
  assert.match(source, /const priced = hasPerm\(session\.permissions, PERMISSIONS\.PRICING_READ\);/);
  assert.match(source, /usageSlices\(\{ \.\.\.filters, day: \{ gte: since \} \}, \{ purchase: priced \}\)/);
  assert.match(source, /purchase: priced \? totals\.purchase : null/);
});
