import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { COMPANY_PERMISSIONS, effectivePermissions, roleTemplates } from "@/lib/auth/permissions";
import {
  applyMarkup,
  marginShare,
  markupColumns,
  markupRuleOf,
  markupScopeOf,
  pickMarkup,
  scaleByMarkup,
} from "@/lib/gateway/billing/markup-policy";
import {
  CHARGEBACK_COLUMNS,
  CHARGEBACK_MARGIN_COLUMNS,
  chargebackColumns,
  chargebackRows,
  chargebackTable,
  groupSpend,
} from "@/lib/usage/usage-stats";
import { toCsv } from "@/lib/export/csv";
import { serializeUsage } from "@/lib/management/serialize";
import { markupSchema } from "@/schemas/pricing";
import { markupKindOf } from "@/lib/pricing/markup-view";
import { markupCreateSchema, markupUpdateSchema } from "@/schemas/management";
import type { AuthenticatedSession, Permission } from "@/types/auth";
import type { BillingGroup, TokenUsage } from "@/types/billing";
import type { Principal } from "@/types/gateway";
import type { Deployment } from "@/types/routing";
import type { UsageSlice } from "@/types/usage";
import type { MarkupRule, MarkupTarget } from "@/types/pricing";

type PrismaCall = { model: string; method: string; args: unknown };
type MarkupRow = { id: string; orgId: string | null; teamId: string | null; projectId: string | null; model: string; percent: number };

const db = {
  calls: [] as PrismaCall[],
  markups: [] as MarkupRow[],
  usage: [] as Record<string, unknown>[],
};

(globalThis as { prisma?: unknown }).prisma = new Proxy(
  {},
  {
    get: (_client, model: string) => {
      if (model === "$transaction") return async (writes: Promise<unknown>[]) => Promise.all(writes);
      return new Proxy(
        {},
        {
          get: (_delegate, method: string) => async (args: unknown) => {
            db.calls.push({ model, method, args });
            if (method === "findMany") {
              if (model === "priceMarkup") return db.markups;
              if (model === "usageDaily") return db.usage;
              return [];
            }
            if (method === "count") return 0;
            if (method === "groupBy") return [];
            if (method === "create" || method === "upsert") return { id: "row-1" };
            return null;
          },
        },
      );
    },
  },
);

function recorded(model: string, method: string): unknown[] {
  return db.calls.filter((call) => call.model === model && call.method === method).map((call) => call.args);
}

function markupRow(id: string, orgId: string | null, model: string, percent: number): MarkupRow {
  return { id, orgId, teamId: null, projectId: null, model, percent };
}

function usageRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    day: new Date("2026-10-09T00:00:00Z"),
    keyId: "",
    teamId: "",
    orgId: "o1",
    projectId: "",
    memberId: "",
    userId: "u1",
    model: "gpt-5",
    requests: 1,
    errors: 0,
    rateLimited: 0,
    latencyMs: 0,
    promptTokens: 10,
    completionTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    cacheSavings: 0,
    purchaseCost: 0,
    ...row,
  };
}

function session(permissions: Permission[]): AuthenticatedSession {
  return {
    error: false,
    sessionId: "",
    user: { id: "u1", username: "finance", orgId: null } as AuthenticatedSession["user"],
    isOwner: false,
    role: null,
    permissions,
    secondFactor: "TOTP",
    ipAddress: null,
    userAgent: null,
  };
}

async function asCaller<T>(permissions: Permission[], fn: () => Promise<T>): Promise<T> {
  const { runAsPrincipal } = await import("@/lib/auth/delegation");
  db.calls.length = 0;
  return runAsPrincipal(session(permissions), fn);
}

const tenant: Principal = { actor: "sk-hub-abc", teamId: "", orgId: "o1", userId: "", memberId: "", models: [], routeLimits: {} };

const sonnet: Deployment = {
  id: "dep-1",
  kind: "openai_compat",
  base_url: "",
  model: "claude-sonnet-5",
  weight: 1,
  cost_input_per_1k: 1,
  cost_output_per_1k: 2,
  provider_id: "",
};

const customPrice: BillingGroup = {
  alias: "claude",
  billing_mode: "custom",
  price_input_per_1k: 3,
  price_output_per_1k: 6,
  price_time_zone: "UTC",
  price_windows: [],
  deployments: [],
};

type DailyWrite = {
  create: Record<string, number | string>;
  update: Record<string, { increment: number }>;
};

async function bill(usage: Partial<TokenUsage>): Promise<{ cost: number; daily: DailyWrite }> {
  const { recordUsage } = await import("@/lib/gateway/billing/billing");
  db.calls.length = 0;
  const cost = await recordUsage({
    principal: tenant,
    model: "api/claude-sonnet-5",
    deployment: sonnet,
    group: customPrice,
    usage,
    status: 200,
    outcome: "ok",
    latencyMs: 5,
  });
  const [daily] = recorded("usageDaily", "upsert") as DailyWrite[];
  return { cost, daily: daily! };
}

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
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
  cacheSavings: 0,
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
  cacheRead: 0,
  cacheWrite: 0,
  cacheSavings: 0,
  cacheHitRate: 0,
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
  db.markups = [markupRow("global", null, "", 10), markupRow("acme-claude", "o1", "claude-*", 20)];
  const { cost, daily } = await bill({ prompt_tokens: 1000, completion_tokens: 1000 });
  near(cost, 9 * 1.2);
  assert.equal(daily.create.model, "claude-sonnet-5");
  assert.equal(daily.create.orgId, "o1");
  near(Number(daily.create.cost), 9 * 1.2);
  near(Number(daily.create.purchaseCost), 3);
  near(daily.update.cost!.increment, 9 * 1.2);
  near(daily.update.purchaseCost!.increment, 3);
  const [spend] = recorded("spendEvent", "create") as { data: { cost: number; model: string } }[];
  near(spend!.data.cost, 9 * 1.2);
  const [lookup] = recorded("priceMarkup", "findMany") as { where: { OR: object[] } }[];
  assert.deepEqual(lookup!.where.OR, [{ orgId: null, teamId: null, projectId: null }, { orgId: "o1" }]);
});

test("recordUsage bills the listed price when no markup applies", async () => {
  db.markups = [];
  const { cost, daily } = await bill({ prompt_tokens: 1000, completion_tokens: 1000 });
  near(cost, 9);
  near(Number(daily.create.purchaseCost), 3);
});

test("usage loads purchase cost only with the margins permission", async () => {
  const { loadUsage } = await import("@/lib/usage/dashboard");
  db.usage = [usageRow({ cost: 1.2, purchaseCost: 1 }), usageRow({ cost: 2.4, purchaseCost: 2, model: "claude-x" })];
  const priced = await asCaller(["spend:read", "pricing:read"], () => loadUsage(7));
  near(priced.purchase ?? -1, 3);
  assert.deepEqual(priced.chargeback.map((row) => row.purchase), [2, 1]);
  near(priced.byOrg[0]?.purchase ?? -1, 3);
  const blind = await asCaller(["spend:read"], () => loadUsage(7));
  assert.equal(blind.purchase, null);
  near(blind.spend, 3.6);
  assert.equal(blind.chargeback.some((row) => "purchase" in row), false);
  assert.equal(blind.byOrg.some((row) => "purchase" in row), false);
});

test("the chargeback export adds purchase cost and margin only for callers who may see margins", async () => {
  const { GET } = await import("@/app/internal-api/usage/chargeback/route");
  db.usage = [usageRow({ cost: 1.2, purchaseCost: 1 })];
  const download = (permissions: Permission[]) =>
    asCaller(permissions, async () =>
      (await GET(new NextRequest("http://hub.local/internal-api/usage/chargeback"))).text(),
    );
  const [pricedHeader] = (await download(["spend:read", "pricing:read"])).split("\n");
  assert.equal(pricedHeader, CHARGEBACK_MARGIN_COLUMNS.join(","));
  const [blindHeader, blindLine] = (await download(["spend:read"])).split("\n");
  assert.equal(blindHeader, CHARGEBACK_COLUMNS.join(","));
  assert.equal(blindLine?.split(",")[CHARGEBACK_COLUMNS.indexOf("spend")], "1.2");
});

function near(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
}

test("prompt cache savings follow the markup without clamping negative savings", async () => {
  assert.equal(scaleByMarkup(2, 25), 2.5);
  assert.equal(scaleByMarkup(-2, 25), -2.5);
  assert.equal(scaleByMarkup(2, -100), 0);
  db.markups = [markupRow("acme", "o1", "", 20)];
  const cached = { prompt_tokens: 1000, completion_tokens: 0, cache_read_input_tokens: 500 };
  const { daily } = await bill(cached);
  near(Number(daily.create.cacheSavings), (3 - 1.65) * 1.2);
  near(daily.update.cacheSavings!.increment, (3 - 1.65) * 1.2);
  db.markups = [markupRow("acme", "o1", "", -100)];
  const free = await bill(cached);
  near(free.cost, 0);
  near(Number(free.daily.create.cacheSavings), 0);
});

test("chargeback CSV puts purchase cost, sale, and margin side by side only when priced", () => {
  const priced = chargebackRows([slice({ orgId: "o1", model: "gpt-5", cost: 1.2, purchaseCost: 1 })]);
  const csv = toCsv(chargebackTable(priced, { o1: "Acme" }), chargebackColumns(true));
  const [header, line] = csv.split("\n");
  assert.equal(header, CHARGEBACK_MARGIN_COLUMNS.join(","));
  assert.match(header ?? "", /,model,purchase_cost,spend,margin,prompt_tokens,/);
  const cells = (line ?? "").split(",");
  assert.equal(Number(cells[CHARGEBACK_MARGIN_COLUMNS.indexOf("purchase_cost")]), 1);
  assert.equal(Number(cells[CHARGEBACK_MARGIN_COLUMNS.indexOf("spend")]), 1.2);
  assert.ok(Math.abs(Number(cells[CHARGEBACK_MARGIN_COLUMNS.indexOf("margin")]) - 0.2) < 1e-9);
  const blind = chargebackRows([slice({ orgId: "o1", model: "gpt-5", cost: 1.2 })]);
  assert.equal(chargebackColumns(false), CHARGEBACK_COLUMNS);
  assert.equal("purchase_cost" in (chargebackTable(blind, {})[0] ?? {}), false);
  assert.doesNotMatch(toCsv(chargebackTable(blind, {}), chargebackColumns(false)), /purchase_cost|margin/);
});

test("scheduled usage reports stay on the sale price like company users", async () => {
  const { buildReportMail } = await import("@/lib/reports/usage-report");
  const { lastCompletedPeriod } = await import("@/lib/reports/period");
  db.usage = [usageRow({ cost: 1.2, purchaseCost: 1 })];
  db.calls.length = 0;
  const now = new Date("2026-10-12T12:00:00Z");
  const period = lastCompletedPeriod("monthly", now);
  const mail = await buildReportMail(
    {
      id: "r1",
      orgId: "o1",
      teamId: null,
      format: "csv",
      locale: "en",
      recipients: ["finance@example.com"],
      org: { alias: "Acme" },
      team: null,
    },
    period,
    now,
  );
  assert.deepEqual(recorded("usageDaily", "findMany"), [
    { where: { orgId: "o1", day: { gte: period.start, lt: period.end } } },
  ]);
  assert.equal(mail.attachments?.length, 1);
  const [header, line] = String(mail.attachments?.[0]?.content).split("\n");
  assert.equal(header, CHARGEBACK_COLUMNS.join(","));
  assert.equal(line?.split(",")[CHARGEBACK_COLUMNS.indexOf("spend")], "1.2");
});

test("a markup row is summarized as a markup, a discount, or the plain price", () => {
  assert.equal(markupKindOf(15), "markup");
  assert.equal(markupKindOf(-10), "discount");
  assert.equal(markupKindOf(0), "none");
});
