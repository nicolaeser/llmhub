import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CHARGEBACK_COLUMNS, chargebackRows, chargebackTable, summarizeUsage, usageDays } from "@/lib/gateway/usage-stats";
import { toCsv } from "@/lib/http/export";
import { lastCompletedPeriod, nextReportAt, reportCadence } from "@/lib/reports/period";
import { usageReportSchema } from "@/schemas/reports";
import type { UsageSlice } from "@/types/gateway";

const at = (iso: string) => new Date(iso);

function exportedAsyncFn(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `missing export async function ${name}`);
  const next = source.indexOf("\nexport ", start + 1);
  return next === -1 ? source.slice(start) : source.slice(start, next);
}

const slice = (row: Partial<UsageSlice>): UsageSlice => ({
  day: "2026-09-28",
  keyId: "",
  teamId: "",
  orgId: "",
  projectId: "",
  memberId: "",
  userId: "",
  model: "",
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

test("weekly reports cover the last full Monday to Sunday week in UTC", () => {
  const period = lastCompletedPeriod("weekly", at("2026-10-07T12:00:00Z"));
  assert.equal(period.start.toISOString(), "2026-09-28T00:00:00.000Z");
  assert.equal(period.end.toISOString(), "2026-10-05T00:00:00.000Z");
  assert.equal(period.days, 7);
  assert.equal(period.key, "weekly:2026-09-28");
});

test("monthly reports cover the previous calendar month, across a year boundary", () => {
  const october = lastCompletedPeriod("monthly", at("2026-10-15T08:00:00Z"));
  assert.equal(october.start.toISOString(), "2026-09-01T00:00:00.000Z");
  assert.equal(october.end.toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(october.days, 30);
  assert.equal(october.key, "monthly:2026-09-01");
  const january = lastCompletedPeriod("monthly", at("2027-01-10T08:00:00Z"));
  assert.equal(january.start.toISOString(), "2026-12-01T00:00:00.000Z");
  assert.equal(january.days, 31);
});

test("a period only counts as completed one hour after it ends", () => {
  assert.equal(lastCompletedPeriod("weekly", at("2026-10-05T00:30:00Z")).key, "weekly:2026-09-21");
  assert.equal(lastCompletedPeriod("weekly", at("2026-10-05T01:00:00Z")).key, "weekly:2026-09-28");
  assert.equal(lastCompletedPeriod("monthly", at("2026-10-01T00:59:00Z")).key, "monthly:2026-08-01");
  assert.equal(lastCompletedPeriod("monthly", at("2026-10-01T01:00:00Z")).key, "monthly:2026-09-01");
});

test("the next report goes out one hour after the running period ends", () => {
  assert.equal(nextReportAt("weekly", at("2026-10-07T12:00:00Z")).toISOString(), "2026-10-12T01:00:00.000Z");
  assert.equal(nextReportAt("monthly", at("2026-10-07T12:00:00Z")).toISOString(), "2026-11-01T01:00:00.000Z");
  assert.equal(nextReportAt("weekly", at("2026-10-12T00:30:00Z")).toISOString(), "2026-10-12T01:00:00.000Z");
});

test("unknown cadences fall back to monthly", () => {
  assert.equal(reportCadence("weekly"), "weekly");
  assert.equal(reportCadence("daily"), "monthly");
});

test("report input lowercases and dedupes recipients and rejects header injection", () => {
  const base = { orgId: "o1", cadence: "weekly", format: "pdf", locale: "de", enabled: true };
  const parsed = usageReportSchema.parse({ ...base, recipients: ["Finance@Example.com", "finance@example.com", "it@corp"] });
  assert.deepEqual(parsed.recipients, ["finance@example.com", "it@corp"]);
  assert.equal(parsed.teamId, "");
  for (const bad of ["a@b.c\r\nBcc: x@y.z", "Name <a@b.c>", "a@b.c,d@e.f", "no-at-sign", "a b@c.d"]) {
    assert.equal(usageReportSchema.safeParse({ ...base, recipients: [bad] }).success, false, bad);
  }
  assert.equal(usageReportSchema.safeParse({ ...base, locale: "fr", recipients: ["a@b.c"] }).success, false);
  assert.equal(usageReportSchema.safeParse({ ...base, format: "xlsx", recipients: ["a@b.c"] }).success, false);
  const many = Array.from({ length: 21 }, (_, index) => `user${index}@example.com`);
  assert.equal(usageReportSchema.safeParse({ ...base, recipients: many }).success, false);
});

test("summarizeUsage fills every day of the period and totals the slices", () => {
  const summary = summarizeUsage(
    [
      slice({ day: "2026-09-28", cost: 1.5, requests: 3, errors: 1, rateLimited: 1, latencyMs: 300, promptTokens: 10, completionTokens: 5 }),
      slice({ day: "2026-09-30", cost: 0.5, requests: 1, latencyMs: 100, promptTokens: 4 }),
      slice({ day: "2026-10-09", cost: 9, requests: 9 }),
    ],
    usageDays(new Date("2026-09-28T00:00:00Z"), 7),
  );
  assert.deepEqual(
    summary.daily.map((day) => day.day),
    ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"],
  );
  assert.deepEqual(summary.daily[0], { day: "2026-09-28", spend: 1.5, requests: 3, errors: 1 });
  assert.equal(summary.spend, 11);
  assert.equal(summary.count, 13);
  assert.equal(summary.tokens, 19);
  assert.equal(summary.errors, 1);
  assert.equal(summary.rate429, 1);
  assert.equal(summary.latency, 400 / 13);
});

test("chargeback CSV names tenants and keeps its header when there is no usage", () => {
  const rows = chargebackRows([slice({ orgId: "o1", teamId: "t1", model: "gpt", cost: 2, promptTokens: 7, completionTokens: 3 })]);
  const csv = toCsv(chargebackTable(rows, { o1: "Acme", t1: "IT, Ops" }), CHARGEBACK_COLUMNS);
  assert.equal(csv.split("\n")[0], CHARGEBACK_COLUMNS.join(","));
  assert.equal(csv.split("\n")[1], 'o1,Acme,t1,"IT, Ops",,,,,,,gpt,2,7,3');
  assert.equal(toCsv([], CHARGEBACK_COLUMNS), `${CHARGEBACK_COLUMNS.join(",")}\n`);
  assert.equal(toCsv([]), "");
});

test("the maintenance sweep delivers due usage reports", async () => {
  const source = await readFile(new URL("../src/worker/jobs.ts", import.meta.url), "utf8");
  assert.match(source, /result\.reports = await runUsageReports\(now\)/);
});

test("report delivery claims a row before sending so parallel sweeps cannot send twice", async () => {
  const source = await readFile(new URL("../src/lib/reports/usage-report.ts", import.meta.url), "utf8");
  const run = exportedAsyncFn(source, "runUsageReports");
  assert.match(run, /if \(!mailEnabled\(\)\) return 0;/);
  assert.match(run, /updateMany\(\{\s*where: \{\s*id: report\.id,[\s\S]*?lastPeriod: report\.lastPeriod,[\s\S]*?claimedUntil/);
  assert.match(run, /if \(claimed\.count !== 1\) continue;/);
  assert.ok(run.indexOf("claimed.count") < run.indexOf("deliverUsageReport("));
  assert.match(run, /mailErrorCode\(err\)/);
});

test("report actions need budgets:manage and spend:read-all and stay in the company scope", async () => {
  const source = await readFile(new URL("../src/app/(app)/companies/_action.ts", import.meta.url), "utf8");
  assert.match(source, /PERMISSIONS\.BUDGETS_MANAGE\) &&\s*hasPerm\(session\.permissions, PERMISSIONS\.SPEND_READ_ALL\)/);
  for (const name of ["saveReportAction", "deleteReportAction", "sendReportNowAction"]) {
    assert.match(exportedAsyncFn(source, name), /await reportSession\(\)/, name);
  }
  assert.match(source, /if \(!row \|\| !inCompany\(session, row\.orgId\)\) throw new Error\("NOT_FOUND"\)/);
  assert.match(source, /seesReports \? reportViews\(session, now\)/);
});
