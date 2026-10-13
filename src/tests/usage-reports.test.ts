import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import test, { after, before, beforeEach } from "node:test";
import { CHARGEBACK_COLUMNS, chargebackRows, chargebackTable, summarizeUsage, usageDays } from "@/lib/usage/usage-stats";
import { toCsv } from "@/lib/export/csv";
import { lastCompletedPeriod, nextReportAt, reportCadence } from "@/lib/reports/period";
import { usageReportSchema } from "@/schemas/reports";
import type { UsageSlice } from "@/types/usage";

const at = (iso: string) => new Date(iso);

type Row = Record<string, unknown>;
type Args = { where?: Row; data?: Row };
type Call = { model: string; method: string; args: Args; count?: number };

const NOW = at("2026-10-07T12:00:00Z");
const PERIOD = "weekly:2026-09-28";
const CLAIM_MS = 10 * 60_000;
const RETRY_MS = 60 * 60_000;

const calls: Call[] = [];
const reports = new Map<string, Row>();
let staleListing: Row[] | null = null;
let reportQueryFailure: Error | null = null;
let reportLookupFailure: Error | null = null;
const smtp = { sessions: 0, recipients: [] as string[], reject: "" };

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([field, condition]) => {
    if (field === "OR") return (condition as Row[]).some((branch) => matches(row, branch));
    const value = row[field];
    if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime();
    if (condition !== null && typeof condition === "object") {
      if ("lt" in condition) return value instanceof Date && value.getTime() < (condition.lt as Date).getTime();
      if ("isEmpty" in condition) return Array.isArray(value) && (value.length === 0) === condition.isEmpty;
      return false;
    }
    return (value ?? null) === condition;
  });
}

const reportModel = {
  findMany: async (args: Args) => {
    calls.push({ model: "usageReport", method: "findMany", args });
    if (reportQueryFailure) throw reportQueryFailure;
    const listed = staleListing ?? [...reports.values()].filter((row) => matches(row, args.where ?? {}));
    return listed.map((row) => ({ ...row }));
  },
  findUnique: async (args: Args) => {
    calls.push({ model: "usageReport", method: "findUnique", args });
    if (reportLookupFailure) throw reportLookupFailure;
    const row = reports.get(String(args.where?.id));
    return row ? { ...row, org: { alias: "Acme" }, team: null } : null;
  },
  updateMany: async (args: Args) => {
    const matched = [...reports.values()].filter((row) => matches(row, args.where ?? {}));
    for (const row of matched) Object.assign(row, args.data);
    calls.push({ model: "usageReport", method: "updateMany", args, count: matched.length });
    return { count: matched.length };
  },
};

function fakeModel(model: string) {
  return new Proxy(
    {},
    {
      get: (_target, method: string) => async (args: Args = {}) => {
        calls.push({ model, method, args });
        if (method === "deleteMany" || method === "updateMany") return { count: 0 };
        if (method === "findMany" || method === "groupBy") return [];
        if (method === "count") return 0;
        if (method === "create" || method === "upsert") return {};
        return null;
      },
    },
  );
}

const fakes = new Map<string, unknown>([["usageReport", reportModel]]);

(globalThis as { prisma?: unknown }).prisma = new Proxy(
  {},
  {
    get: (_target, model: string) => {
      if (model.startsWith("$")) return async () => [];
      const fake = fakes.get(model) ?? fakeModel(model);
      fakes.set(model, fake);
      return fake;
    },
  },
);
delete process.env.REDIS_URL;

const smtpServer = createServer((socket) => {
  smtp.sessions += 1;
  socket.setEncoding("utf8");
  socket.on("error", () => undefined);
  if (smtp.reject) {
    socket.end(`${smtp.reject}\r\n`);
    return;
  }
  socket.write("220 fake.test ready\r\n");
  let buffer = "";
  let inData = false;
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\r\n"); end >= 0; end = buffer.indexOf("\r\n")) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (inData) {
        if (line === ".") {
          inData = false;
          socket.write("250 queued\r\n");
        }
        continue;
      }
      const verb = line.split(" ")[0].toUpperCase();
      if (verb === "RCPT") smtp.recipients.push(line);
      inData = verb === "DATA";
      socket.write(inData ? "354 go ahead\r\n" : verb === "QUIT" ? "221 bye\r\n" : "250 ok\r\n");
      if (verb === "QUIT") socket.end();
    }
  });
});

before(async () => {
  smtpServer.listen(0, "127.0.0.1");
  await once(smtpServer, "listening");
  process.env.SMTP_URL = `smtp://127.0.0.1:${(smtpServer.address() as AddressInfo).port}`;
});

after(() => {
  smtpServer.close();
});

beforeEach(() => {
  calls.length = 0;
  reports.clear();
  staleListing = null;
  reportQueryFailure = null;
  reportLookupFailure = null;
  Object.assign(smtp, { sessions: 0, recipients: [], reject: "" });
});

function report(id: string, over: Row = {}): Row {
  const row = {
    id,
    orgId: "org_1",
    teamId: null,
    cadence: "weekly",
    format: "csv",
    locale: "en",
    recipients: ["finance@example.com"],
    enabled: true,
    lastPeriod: "",
    lastSentAt: null,
    lastError: "",
    claimedUntil: null,
    ...over,
  };
  reports.set(id, row);
  return row;
}

function reportCalls(method: string): Call[] {
  return calls.filter((call) => call.model === "usageReport" && call.method === method);
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

test("the maintenance sweep delivers due usage reports", async (t) => {
  const { runMaintenanceSweep } = await import("@/worker/jobs");
  report("due");
  report("sent", { lastPeriod: PERIOD });
  report("paused", { enabled: false });
  report("nobody", { recipients: [] });

  assert.equal((await runMaintenanceSweep(NOW)).reports, 1);
  assert.equal(smtp.sessions, 1);
  assert.deepEqual(smtp.recipients, ["RCPT TO:<finance@example.com>"]);
  const due = reports.get("due")!;
  assert.deepEqual(
    [due.lastPeriod, due.lastSentAt, due.lastError, due.claimedUntil],
    [PERIOD, NOW, "", null],
  );

  reportQueryFailure = new Error("report query failed");
  const logged = t.mock.method(console, "error", () => {});
  assert.equal((await runMaintenanceSweep(NOW)).reports, 0);
  const failures = logged.mock.calls
    .map((call) => JSON.parse(String(call.arguments[0])))
    .filter((line) => line.event === "worker.job_failed" && line.job === "usage_reports");
  assert.deepEqual(failures.map((line) => line.err), ["report query failed"]);
});

test("report delivery claims a row before sending so parallel sweeps cannot send twice", async () => {
  const { runUsageReports } = await import("@/lib/reports/usage-report");
  report("due");
  report("held", { claimedUntil: new Date(NOW.getTime() + 60_000) });

  const sent = await Promise.all([runUsageReports(NOW), runUsageReports(NOW), runUsageReports(NOW)]);
  assert.deepEqual(sent.sort(), [0, 0, 1]);
  assert.equal(smtp.sessions, 1);
  const won = reportCalls("updateMany").filter((call) => call.count === 1 && call.args.where?.lastPeriod === "");
  assert.equal(won.length, 1);
  assert.deepEqual(won[0].args, {
    where: {
      id: "due",
      enabled: true,
      cadence: "weekly",
      lastPeriod: "",
      OR: [{ claimedUntil: null }, { claimedUntil: { lt: NOW } }],
    },
    data: { claimedUntil: new Date(NOW.getTime() + CLAIM_MS) },
  });
  const deliveries = reportCalls("findUnique");
  assert.deepEqual(deliveries.map((call) => call.args.where?.id), ["due"]);
  assert.ok(calls.indexOf(won[0]) < calls.indexOf(deliveries[0]));
  assert.equal(reports.get("due")!.lastPeriod, PERIOD);

  calls.length = 0;
  assert.equal(await runUsageReports(NOW), 0);
  assert.deepEqual(reportCalls("updateMany"), []);

  reports.clear();
  report("raced", { lastPeriod: PERIOD, lastSentAt: NOW });
  staleListing = [{ id: "raced", cadence: "weekly", lastPeriod: "" }];
  calls.length = 0;
  assert.equal(await runUsageReports(NOW), 0);
  assert.deepEqual(reportCalls("updateMany").map((call) => call.count), [0]);
  assert.deepEqual(reportCalls("findUnique"), []);
  assert.equal(smtp.sessions, 1);
});

test("a failed report delivery records the mail error code and waits an hour before retrying", async (t) => {
  const { runUsageReports } = await import("@/lib/reports/usage-report");
  const logged = t.mock.method(console, "log", () => {});
  report("due");
  smtp.reject = "554 5.7.1 relay denied";
  assert.equal(await runUsageReports(NOW), 0);
  assert.equal(smtp.sessions, 1);
  const due = reports.get("due")!;
  assert.deepEqual(
    [due.lastPeriod, due.lastError, due.claimedUntil],
    ["", "SMTP_554", new Date(NOW.getTime() + RETRY_MS)],
  );

  assert.equal(await runUsageReports(new Date(NOW.getTime() + RETRY_MS / 2)), 0);
  assert.equal(smtp.sessions, 1);

  reports.clear();
  report("broken");
  reportLookupFailure = new Error("connection to 10.0.0.5 lost");
  assert.equal(await runUsageReports(NOW), 0);
  assert.equal(reports.get("broken")!.lastError, "MAIL_FAILED");
  assert.deepEqual(
    logged.mock.calls.map((call) => JSON.parse(String(call.arguments[0]))).map((line) => [line.event, line.reportId, line.err]),
    [
      ["report.send_failed", "due", "SMTP_554"],
      ["report.send_failed", "broken", "MAIL_FAILED"],
    ],
  );
});
