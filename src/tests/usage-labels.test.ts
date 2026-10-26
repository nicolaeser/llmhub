import assert from "node:assert/strict";
import test from "node:test";
import { createFormatter, createTranslator, type Messages } from "next-intl";
import { formats } from "@/i18n/formats";
import { loadLocaleMessages } from "@/i18n/messages";
import { toCsv } from "@/lib/export/csv";
import { usageStatsPdf } from "@/lib/export/usage-pdf";
import { serializeRequestLog, serializeUsage } from "@/lib/management/serialize";
import {
  chargebackColumns,
  chargebackParts,
  chargebackRows,
  chargebackTable,
  groupByLabel,
  labelBreakdown,
  labelSummaryTable,
  summarizeUsage,
  usageDays,
} from "@/lib/usage/usage-stats";
import { logsQuerySchema, usageQuerySchema } from "@/schemas/management";
import { readPdf } from "./support/pdf-text";
import type { AuthenticatedSession, Permission } from "@/types/auth";
import type { RequestLogRow } from "@/types/logs";
import type { UsageSource } from "@/types/management";
import type { UsageSlice } from "@/types/usage";

type Call = { model: string; method: string; args: { where?: Record<string, unknown>; by?: string[] } };

const calls: Call[] = [];
const lookups: Record<string, unknown> = {};

(globalThis as { prisma?: unknown }).prisma = new Proxy(
  {},
  {
    get: (_target, model: string) =>
      new Proxy(
        {},
        {
          get: (_inner, method: string) => async (args: Call["args"]) => {
            calls.push({ model, method, args });
            if (model === "requestLog" && method === "count") return 4;
            if (model === "requestLog" && method === "findFirst") return { latencyMs: 700 };
            const found = lookups[`${model}.${method}`];
            return typeof found === "function" ? found(args) : (found ?? []);
          },
        },
      ),
  },
);

const slice = (row: Partial<UsageSlice>): UsageSlice => ({
  day: "2026-10-05",
  keyId: "k1",
  teamId: "t1",
  orgId: "o1",
  projectId: "p1",
  memberId: "",
  userId: "",
  model: "gpt",
  requests: 0,
  errors: 0,
  rateLimited: 0,
  latencyMs: 0,
  promptTokens: 0,
  completionTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
  cacheSavings: 0,
  ...row,
});

const daily = [
  slice({ requests: 10, errors: 1, cost: 1.3, promptTokens: 100, completionTokens: 50, latencyMs: 1000 }),
  slice({ model: "claude", requests: 4, cost: 0.4, promptTokens: 40, completionTokens: 10, latencyMs: 400 }),
];
const labeled = [
  slice({ label: "prod", requests: 6, errors: 1, cost: 0.9, promptTokens: 60, completionTokens: 30, latencyMs: 600 }),
  slice({ label: "dev", requests: 4, cost: 0.4, promptTokens: 40, completionTokens: 20, latencyMs: 400 }),
  slice({ model: "claude", label: "prod", requests: 4, cost: 0.4, promptTokens: 40, completionTokens: 10, latencyMs: 400 }),
];

test("a label breakdown adds the unlabelled rest per slice so the rows sum to the totals", () => {
  const rows = labelBreakdown(daily, labeled);
  assert.equal(rows.filter((row) => row.label === "").length, 0);
  const groups = groupByLabel(rows);
  assert.deepEqual(
    groups.map((row) => [row.name, row.requests, Number(row.spend.toFixed(10))]),
    [
      ["prod", 10, 1.3],
      ["dev", 4, 0.4],
    ],
  );
  const partial = labelBreakdown(daily, labeled.slice(1));
  const none = groupByLabel(partial).find((row) => row.name === "");
  assert.deepEqual([none?.requests, Number(none?.spend.toFixed(10))], [6, 0.9]);
  const totals = summarizeUsage(partial, usageDays(new Date("2026-10-05T00:00:00Z"), 1));
  const original = summarizeUsage(daily, usageDays(new Date("2026-10-05T00:00:00Z"), 1));
  assert.equal(totals.count, original.count);
  assert.equal(Number(totals.spend.toFixed(10)), Number(original.spend.toFixed(10)));
});

test("chargeback rows carry the label value and keep model names with slashes intact", () => {
  const rows = chargebackRows([
    slice({ model: "openai/gpt-4o", label: "cc/4711", cost: 2, promptTokens: 3, completionTokens: 1 }),
    slice({ model: "openai/gpt-4o", label: "", cost: 1, promptTokens: 1 }),
  ]);
  assert.deepEqual(chargebackParts(rows[0]!.name), {
    orgId: "o1",
    teamId: "t1",
    projectId: "p1",
    memberId: "",
    keyId: "k1",
    userId: "",
    model: "openai/gpt-4o",
    label: "cc/4711",
  });
  assert.equal(chargebackParts(rows[1]!.name).label, "");
  assert.equal("label" in chargebackParts("o1/-/-/-/-/-/gpt"), false);
  assert.deepEqual(
    chargebackColumns(false, true).slice(9, 14),
    ["user_id", "model", "label_key", "label_value", "spend"],
  );
  assert.equal(chargebackColumns(true).includes("label_key"), false);
  const [first] = chargebackTable(rows, { o1: "Acme" }, "cost_center");
  assert.deepEqual([first?.label_key, first?.label_value, first?.model], ["cost_center", "cc/4711", "openai/gpt-4o"]);
  assert.equal("label_key" in (chargebackTable(rows, {})[0] ?? {}), false);
});

test("the label summary lists every key and value, with No label as an empty value", () => {
  const table = labelSummaryTable([{ key: "env", rows: groupByLabel(labelBreakdown(daily, labeled.slice(1))) }]);
  assert.deepEqual(
    table.map((row) => [row.label_key, row.label_value, row.requests]),
    [
      ["env", "", 6],
      ["env", "dev", 4],
      ["env", "prod", 4],
    ],
  );
});

test("CSV cells that a spreadsheet would run as a formula are quoted as text", () => {
  const csv = toCsv([{ label_value: "=HYPERLINK(\"x\")", other: "+1", at: "@me", minus: -5, plain: "ok" }]);
  const [, line] = csv.trim().split("\n");
  assert.equal(line, `"'=HYPERLINK(""x"")",'+1,'@me,-5,ok`);
});

test("management queries accept group_by=label:<key> and label=<key>:<value> and reject mismatches", () => {
  const grouped = usageQuerySchema.parse({ group_by: "label:Cost-Center" });
  assert.equal(grouped.group_by, "cost_center");
  assert.equal(grouped.label, null);
  const filtered = usageQuerySchema.parse({ group_by: "label:env", label: "env:prod" });
  assert.deepEqual(filtered.label, { key: "env", value: "prod" });
  assert.equal(usageQuerySchema.safeParse({ group_by: "model" }).success, false);
  assert.equal(usageQuerySchema.safeParse({ label: "env" }).success, false);
  const conflict = usageQuerySchema.safeParse({ group_by: "label:env", label: "feature:chat" });
  assert.equal(conflict.success, false);
  assert.deepEqual(conflict.error?.issues[0]?.path, ["group_by"]);
  assert.deepEqual(logsQuerySchema.parse({ label: "feature:chat" }).label, { key: "feature", value: "chat" });
  assert.equal(logsQuerySchema.parse({}).label, null);
});

test("usage and request log serializers expose labels in snake_case", () => {
  const base: UsageSource = {
    days: 7,
    model: "",
    teamId: "",
    orgId: "",
    projectId: "",
    memberId: "",
    keyId: "",
    userId: "",
    labelKey: "env",
    labelValue: "",
    spend: 1.7,
    tokens: 0,
    count: 14,
    errors: 1,
    rate429: 0,
    latency: 0,
    p95Latency: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheSavings: 0,
    cacheHitRate: 0,
    daily: [],
    byModel: [],
    byTeam: [],
    byOrg: [],
    byProject: [],
    byMember: [],
    byKey: [],
    byUser: [],
    byLabel: groupByLabel(labelBreakdown(daily, labeled.slice(1))),
    chargeback: chargebackRows(labelBreakdown(daily, labeled.slice(1))),
  };
  const usage = serializeUsage(base) as Record<string, unknown> & {
    by_label: { value: string | null; requests: number }[];
    chargeback: Record<string, unknown>[];
  };
  assert.equal(usage.group_by, "label:env");
  assert.deepEqual((usage.filters as Record<string, unknown>).label, null);
  assert.deepEqual(
    usage.by_label.map((row) => [row.value, row.requests]),
    [
      [null, 6],
      ["dev", 4],
      ["prod", 4],
    ],
  );
  assert.ok(usage.chargeback.every((row) => row.label_key === "env" && "label_value" in row));
  const plain = serializeUsage({ ...base, labelKey: "", byLabel: [] }) as Record<string, unknown>;
  assert.equal(plain.group_by, null);
  assert.equal("by_label" in plain, false);
  const filtered = serializeUsage({ ...base, labelValue: "prod" }) as { filters: Record<string, unknown> };
  assert.deepEqual(filtered.filters.label, { key: "env", value: "prod" });

  const row = { labels: [{ key: "env", value: "prod" }] } as RequestLogRow;
  assert.deepEqual(serializeRequestLog(row).labels, { env: "prod" });
});

function reader(permissions: Permission[]): AuthenticatedSession {
  return {
    error: false,
    sessionId: "s1",
    user: { id: "u-self", username: "analyst", email: "a@example.com", orgId: null } as AuthenticatedSession["user"],
    isOwner: false,
    role: null,
    permissions,
    secondFactor: "TOTP",
    ipAddress: null,
    userAgent: null,
  };
}

const dbRow = (row: UsageSlice) => {
  const { label, day, ...rest } = row;
  return { ...rest, day: new Date(`${day}T00:00:00Z`), purchaseCost: 0, ...(label === undefined ? {} : { label: "env", value: label }) };
};

async function load(input: Parameters<typeof import("@/lib/usage/dashboard").loadUsage>[0]) {
  const { runAsPrincipal } = await import("@/lib/auth/delegation");
  const { loadUsage } = await import("@/lib/usage/dashboard");
  calls.length = 0;
  lookups["usageDaily.findMany"] = daily.map(dbRow);
  lookups["usageLabelDaily.findMany"] = (args: Call["args"]) =>
    labeled.filter((row) => !args.where?.value || row.label === args.where.value).map(dbRow);
  lookups["usageLabelDaily.groupBy"] = (args: Call["args"]) =>
    args.by?.[0] === "label" ? [{ label: "env" }] : [{ value: "dev" }, { value: "prod" }];
  return runAsPrincipal(reader(["spend:read", "spend:read-all"]), () => loadUsage(input));
}

test("loadUsage groups by a label key without changing the totals", async () => {
  const usage = await load({ days: 7, labelKey: "Env" });
  assert.equal(usage.labelKey, "env");
  assert.equal(usage.labelValue, "");
  assert.deepEqual(usage.labelKeys, ["env"]);
  assert.deepEqual(usage.labelValues, ["dev", "prod"]);
  assert.equal(usage.count, 14);
  assert.deepEqual(
    usage.byLabel.map((row) => [row.name, row.requests]),
    [
      ["prod", 10],
      ["dev", 4],
    ],
  );
  assert.ok(usage.chargeback.every((row) => chargebackParts(row.name).label !== undefined));
  const labelQuery = calls.find((call) => call.model === "usageLabelDaily" && call.method === "findMany");
  assert.equal(labelQuery?.args.where?.label, "env");
  assert.equal("value" in (labelQuery?.args.where ?? {}), false);
});

test("loadUsage filters by a label value through the label rollup and the log index", async () => {
  const usage = await load({ days: 7, labelKey: "env", labelValue: " prod " });
  assert.equal(usage.labelValue, "prod");
  assert.equal(usage.count, 10);
  assert.deepEqual(usage.byLabel.map((row) => row.name), ["prod"]);
  assert.equal(calls.some((call) => call.model === "usageDaily" && call.method === "findMany"), false);
  const latency = calls.find((call) => call.model === "requestLog" && call.method === "count");
  assert.deepEqual(latency?.args.where?.labels, { has: "env:prod" });
  const ignored = await load({ days: 7, labelValue: "prod" });
  assert.equal(ignored.labelValue, "");
  assert.equal(ignored.count, 14);
});

test("usage PDFs add a page with the spend per label value, named No label for the rest", async () => {
  const messages = (await loadLocaleMessages("en")) as Messages;
  const now = new Date("2026-10-07T12:00:00Z");
  const t = createTranslator({ locale: "en", messages, formats, timeZone: "UTC", now, namespace: "Usage" });
  const format = createFormatter({ locale: "en", formats, timeZone: "UTC", now });
  const rows = labelBreakdown(daily, labeled.slice(1));
  const summary = summarizeUsage(rows, usageDays(new Date("2026-10-05T00:00:00Z"), 1));
  const bytes = usageStatsPdf({
    stats: {
      ...summary,
      p95Latency: 0,
      byModel: [],
      chargeback: chargebackRows(rows),
      byLabel: [{ key: "env", rows: groupByLabel(rows) }],
    },
    t,
    format,
    brand: "LLM Hub",
    period: "Last day",
    generatedAt: now,
    dayDate: (day) => new Date(`${day}T00:00:00Z`),
  });
  const pdf = Buffer.from(bytes).toString("latin1");
  assert.equal(Number(pdf.match(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/)?.[1]), 2);
  const texts = readPdf(bytes).texts.map((shown) => shown.text);
  assert.ok(texts.includes("Spend by label env"));
  assert.ok(texts.includes("No label"));
  assert.ok(texts.includes("dev"));
});

test("scheduled report mails summarise every label key in the PDF and a labels CSV", async () => {
  const { buildReportMail } = await import("@/lib/reports/usage-report");
  const { lastCompletedPeriod } = await import("@/lib/reports/period");
  lookups["usageDaily.findMany"] = daily.map(dbRow);
  lookups["usageLabelDaily.findMany"] = labeled.map(dbRow);
  const mail = await buildReportMail(
    { id: "r1", orgId: "o1", teamId: null, format: "both", locale: "en", recipients: ["a@example.com"], org: { alias: "Acme" }, team: null },
    lastCompletedPeriod("monthly", new Date("2026-10-07T12:00:00Z")),
    new Date("2026-10-07T12:00:00Z"),
  );
  const names = mail.attachments?.map((file) => file.filename) ?? [];
  assert.equal(names.length, 3);
  const labels = mail.attachments?.find((file) => file.filename.endsWith("-labels.csv"));
  assert.ok(labels);
  assert.equal(
    String(labels.content),
    "label_key,label_value,requests,spend,prompt_tokens,completion_tokens\nenv,prod,10,1.3,100,40\nenv,dev,4,0.4,40,20\n",
  );
  const pdf = mail.attachments?.find((file) => file.filename.endsWith(".pdf"));
  assert.ok(readPdf(pdf!.content as Uint8Array).texts.some((shown) => shown.text === "Spend by label env"));
});
