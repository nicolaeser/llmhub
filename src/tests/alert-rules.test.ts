import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import {
  alertMailRecipients,
  anomalyLookbackDays,
  claimCooldown,
  errorRate,
  errorRateMessage,
  historyDays,
  isErrorRateSpike,
  isSpendAnomaly,
  latencyBaselineWindow,
  latencyMessage,
  latencySpike,
  nextAnomalyState,
  nextIncidentState,
  sameHourWindows,
  TRAFFIC_ALERT_COOLDOWN_MS,
  trafficAlertRule,
  trafficScopes,
} from "@/lib/alerts/rules";
import type { TrafficAlertRule } from "@/types/alerts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-10-09T12:00:00.000Z");

type Range = { gte?: Date; gt?: Date; lte?: Date; lt?: Date };
type Event = { keyId: string; projectId: string; cost: number; createdAt: Date };
type Log = { model: string; status: number; latencyMs: number; createdAt: Date };
type LogWhere = { createdAt?: Range; status?: { not?: number }; model?: string };

const db = {
  settings: new Map<string, string>(),
  events: [] as Event[],
  keys: [] as { id: string; keyAlias: string; prefix: string; createdAt: Date; expiresAt: Date | null; blocked: boolean }[],
  projects: [] as { id: string; alias: string; createdAt: Date }[],
  audit: [] as { action: string; objectId: string; objectType?: string; afterJson?: string }[],
  logs: [] as Log[],
};

function inRange(at: Date, range: Range): boolean {
  const t = at.getTime();
  return (
    (!range.gte || t >= range.gte.getTime()) &&
    (!range.gt || t > range.gt.getTime()) &&
    (!range.lte || t <= range.lte.getTime()) &&
    (!range.lt || t < range.lt.getTime())
  );
}

function logsWhere(where: LogWhere): Log[] {
  return db.logs.filter(
    (log) =>
      (!where.createdAt || inRange(log.createdAt, where.createdAt)) &&
      (where.status?.not === undefined || log.status !== where.status.not) &&
      (where.model === undefined || log.model === where.model),
  );
}

function matchesId(value: string, cond?: { not?: string; in?: string[] }): boolean {
  if (!cond) return true;
  if (cond.not !== undefined && value === cond.not) return false;
  if (cond.in && !cond.in.includes(value)) return false;
  return true;
}

(globalThis as { prisma?: unknown }).prisma = {
  setting: {
    findUnique: async ({ where }: { where: { key: string } }) => {
      const value = db.settings.get(where.key);
      return value === undefined ? null : { key: where.key, value };
    },
    upsert: async ({ where, update }: { where: { key: string }; update: { value: string } }) => {
      db.settings.set(where.key, update.value);
    },
  },
  spendEvent: {
    groupBy: async ({
      by,
      where,
    }: {
      by: ["keyId" | "projectId"];
      where: {
        keyId?: { not?: string; in?: string[] };
        projectId?: { not?: string; in?: string[] };
        createdAt?: Range;
        OR?: { createdAt: Range }[];
      };
    }) => {
      const field = by[0];
      const sums = new Map<string, number>();
      for (const event of db.events) {
        if (!matchesId(event.keyId, where.keyId) || !matchesId(event.projectId, where.projectId)) continue;
        if (where.createdAt && !inRange(event.createdAt, where.createdAt)) continue;
        if (where.OR && !where.OR.some((or) => inRange(event.createdAt, or.createdAt))) continue;
        sums.set(event[field], (sums.get(event[field]) ?? 0) + event.cost);
      }
      return [...sums].map(([id, cost]) => ({ [field]: id, _sum: { cost } }));
    },
  },
  virtualKey: {
    findMany: async ({ where }: { where: { id?: { in: string[] }; blocked?: boolean; expiresAt?: Range } }) =>
      db.keys.filter(
        (key) =>
          (!where.id || where.id.in.includes(key.id)) &&
          (where.blocked === undefined || key.blocked === where.blocked) &&
          (!where.expiresAt || (key.expiresAt !== null && inRange(key.expiresAt, where.expiresAt))),
      ),
  },
  project: {
    findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
      db.projects.filter((project) => where.id.in.includes(project.id)),
  },
  requestLog: {
    groupBy: async ({ where }: { by: ["model", "status"]; where: LogWhere }) => {
      const groups = new Map<string, { model: string; status: number; _count: { _all: number } }>();
      for (const log of logsWhere(where)) {
        const key = `${log.model}|${log.status}`;
        const group = groups.get(key) ?? { model: log.model, status: log.status, _count: { _all: 0 } };
        group._count._all += 1;
        groups.set(key, group);
      }
      return [...groups.values()];
    },
    count: async ({ where }: { where: LogWhere }) => logsWhere(where).length,
    findFirst: async ({ where, skip }: { where: LogWhere; skip: number }) =>
      logsWhere(where).sort((a, b) => a.latencyMs - b.latencyMs)[skip] ?? null,
  },
  gatewayAuditLog: {
    create: async ({ data }: { data: { action: string; objectId: string } }) => {
      db.audit.push(data);
      return data;
    },
  },
};
delete process.env.REDIS_URL;

const realFetch = globalThis.fetch;
let messages: { event: string; message: string }[] = [];

function webhooks(events: string[], extra: Record<string, unknown> = {}) {
  db.settings.set(
    "enterprise",
    JSON.stringify({ alert_webhooks: [{ id: "ops", url: "https://ops.test/hook", secret: "", events }], ...extra }),
  );
}

beforeEach(() => {
  db.settings = new Map();
  db.events = [];
  db.keys = [];
  db.projects = [];
  db.audit = [];
  db.logs = [];
  messages = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    messages.push({ event: body.event, message: body.message });
    return new Response("ok");
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function spend(keyId: string, projectId: string, cost: number, agoMs: number) {
  db.events.push({ keyId, projectId, cost, createdAt: new Date(NOW.getTime() - agoMs) });
}

test("sameHourWindows covers the same hour on each previous day", () => {
  assert.deepEqual(sameHourWindows(NOW, 2), [
    { gte: new Date("2026-10-08T11:00:00.000Z"), lt: new Date("2026-10-08T12:00:00.000Z") },
    { gte: new Date("2026-10-07T11:00:00.000Z"), lt: new Date("2026-10-07T12:00:00.000Z") },
  ]);
});

test("anomaly lookback stays inside spend retention and history starts at creation", () => {
  assert.equal(anomalyLookbackDays(0), 7);
  assert.equal(anomalyLookbackDays(30), 7);
  assert.equal(anomalyLookbackDays(3), 2);
  assert.equal(anomalyLookbackDays(1), 0);
  assert.equal(historyDays(new Date(NOW.getTime() - 2.5 * DAY), NOW, 7), 2);
  assert.equal(historyDays(new Date(NOW.getTime() - 20 * HOUR), NOW, 7), 0);
  assert.equal(historyDays(new Date(NOW.getTime() - 40 * DAY), NOW, 7), 7);
});

test("isSpendAnomaly needs both the factor and the minimum amount", () => {
  const rule = { factor: 3, minCost: 5 };
  assert.equal(isSpendAnomaly(30, 10, rule), true);
  assert.equal(isSpendAnomaly(29, 10, rule), false);
  assert.equal(isSpendAnomaly(4, 0, rule), false);
  assert.equal(isSpendAnomaly(5, 0, rule), true);
  assert.equal(isSpendAnomaly(100, 1, { factor: 0, minCost: 0 }), false);
});

test("nextAnomalyState fires once per episode and holds a cooldown after recovery", () => {
  const first = nextAnomalyState({}, ["key:a"], NOW);
  assert.deepEqual(first.fire, ["key:a"]);
  const still = nextAnomalyState(first.state, ["key:a"], new Date(NOW.getTime() + 3 * HOUR));
  assert.deepEqual(still.fire, []);
  const recovered = nextAnomalyState(first.state, [], new Date(NOW.getTime() + 30 * 60 * 1000));
  assert.deepEqual(Object.keys(recovered.state), ["key:a"]);
  const expired = nextAnomalyState(first.state, [], new Date(NOW.getTime() + HOUR));
  assert.deepEqual(expired.state, {});
});

test("claimCooldown allows one claim per subject per window", () => {
  const seen = new Map<string, number>();
  assert.equal(claimCooldown(seen, "k", 0, 100), true);
  assert.equal(claimCooldown(seen, "k", 50, 100), false);
  assert.equal(claimCooldown(seen, "other", 50, 100), true);
  assert.equal(claimCooldown(seen, "k", 100, 100), true);
});

test("runSpendAnomalyAlerts compares the last hour with the same hour on previous days", async () => {
  const { runSpendAnomalyAlerts } = await import("@/worker/alert-checks");
  webhooks(["spend_anomaly"]);
  db.keys = [
    { id: "k1", keyAlias: "prod", prefix: "sk-hub-aaaaa", createdAt: new Date(NOW.getTime() - 30 * DAY), expiresAt: null, blocked: false },
    { id: "k2", keyAlias: "", prefix: "sk-hub-bbbbb", createdAt: new Date(NOW.getTime() - 30 * DAY), expiresAt: null, blocked: false },
    { id: "k3", keyAlias: "fresh", prefix: "sk-hub-ccccc", createdAt: new Date(NOW.getTime() - 5 * HOUR), expiresAt: null, blocked: false },
  ];
  db.projects = [{ id: "p1", alias: "search", createdAt: new Date(NOW.getTime() - 30 * DAY) }];
  for (let day = 1; day <= 7; day += 1) {
    spend("k1", "p1", 2, day * DAY + 30 * 60 * 1000);
    spend("k2", "", 10, day * DAY + 30 * 60 * 1000);
  }
  spend("k1", "p1", 2, 3 * HOUR);
  spend("k1", "p1", 25, 10 * 60 * 1000);
  spend("k2", "", 12, 10 * 60 * 1000);
  spend("k3", "", 50, 10 * 60 * 1000);

  assert.equal(await runSpendAnomalyAlerts(NOW), 2);
  assert.deepEqual(
    messages.map((m) => m.message).sort(),
    [
      "key prod spent $25.00 in the last hour; the same hour averaged $2.00 over the previous 7 days",
      "project search spent $25.00 in the last hour; the same hour averaged $2.00 over the previous 7 days",
    ],
  );
  assert.deepEqual(
    db.audit.filter((a) => a.action === "spend_anomaly").map((a) => a.objectId).sort(),
    ["k1", "p1"],
  );

  assert.equal(await runSpendAnomalyAlerts(new Date(NOW.getTime() + 60 * 1000)), 0);
  assert.equal(messages.length, 2);
});

test("runSpendAnomalyAlerts respects the configured factor and minimum", async () => {
  const { runSpendAnomalyAlerts } = await import("@/worker/alert-checks");
  webhooks(["spend_anomaly"], { spend_anomaly_factor: 30, spend_anomaly_min_cost: 1 });
  db.keys = [
    { id: "k1", keyAlias: "prod", prefix: "sk-hub-aaaaa", createdAt: new Date(NOW.getTime() - 30 * DAY), expiresAt: null, blocked: false },
  ];
  spend("k1", "", 7, DAY + 30 * 60 * 1000);
  spend("k1", "", 25, 10 * 60 * 1000);
  assert.equal(await runSpendAnomalyAlerts(NOW), 0);

  webhooks(["spend_anomaly"], { spend_anomaly_factor: 0 });
  assert.equal(await runSpendAnomalyAlerts(NOW), 0);
  assert.equal(messages.length, 0);
});

test("runKeyExpiryAlerts warns once per expiry date inside the window", async () => {
  const { runKeyExpiryAlerts } = await import("@/worker/alert-checks");
  webhooks(["key_expiring"], { key_expiry_warning_days: 7 });
  const base = { createdAt: new Date(NOW.getTime() - 30 * DAY), blocked: false };
  db.keys = [
    { ...base, id: "soon", keyAlias: "ci", prefix: "sk-hub-aaaaa", expiresAt: new Date(NOW.getTime() + 2 * DAY) },
    { ...base, id: "tomorrow", keyAlias: "", prefix: "sk-hub-bbbbb", expiresAt: new Date(NOW.getTime() + 20 * HOUR) },
    { ...base, id: "later", keyAlias: "later", prefix: "sk-hub-ccccc", expiresAt: new Date(NOW.getTime() + 30 * DAY) },
    { ...base, id: "gone", keyAlias: "gone", prefix: "sk-hub-ddddd", expiresAt: new Date(NOW.getTime() - DAY) },
    { ...base, id: "blocked", keyAlias: "blocked", prefix: "sk-hub-eeeee", expiresAt: new Date(NOW.getTime() + DAY), blocked: true },
  ];

  assert.equal(await runKeyExpiryAlerts(NOW), 2);
  assert.deepEqual(messages.map((m) => m.message).sort(), [
    "key ci expires at 2026-10-11T12:00:00.000Z (in 2 days)",
    "key sk-hub-bbbbb expires at 2026-10-10T08:00:00.000Z (in 1 day)",
  ]);

  assert.equal(await runKeyExpiryAlerts(new Date(NOW.getTime() + HOUR)), 0);

  db.keys[0].expiresAt = new Date(NOW.getTime() + 5 * DAY);
  assert.equal(await runKeyExpiryAlerts(new Date(NOW.getTime() + 2 * HOUR)), 1);
  assert.equal(messages.length, 3);
});

const MINUTE = 60 * 1000;

const RULE: TrafficAlertRule = {
  windowMinutes: 15,
  minRequests: 50,
  errorRatePercent: 10,
  latencyP95Ms: 30_000,
  latencyFactor: 3,
};

function requests(now: Date, model: string, count: number, status: number, latencyMs = 1_000, agoMs = 5 * MINUTE) {
  for (let i = 0; i < count; i += 1) {
    db.logs.push({ model, status, latencyMs, createdAt: new Date(now.getTime() - agoMs) });
  }
}

test("trafficAlertRule fills defaults and clamps stored values", async () => {
  assert.deepEqual(trafficAlertRule({}), RULE);
  assert.deepEqual(
    trafficAlertRule({
      traffic_window_minutes: 1,
      traffic_min_requests: 0,
      error_rate_threshold: 140,
      latency_p95_ms: -5,
      latency_factor: 0.5,
    }),
    { windowMinutes: 5, minRequests: 1, errorRatePercent: 100, latencyP95Ms: 0, latencyFactor: 1 },
  );
  assert.equal(trafficAlertRule({ traffic_window_minutes: 900 }).windowMinutes, 240);
  assert.equal(trafficAlertRule({ latency_factor: 0, error_rate_threshold: 0 }).latencyFactor, 0);
  const { normalizeEnterprise } = await import("@/lib/settings/enterprise");
  const stored = normalizeEnterprise({ traffic_window_minutes: "30", latency_p95_ms: 12_000.7 });
  assert.equal(stored.traffic_window_minutes, 30);
  assert.equal(stored.latency_p95_ms, 12_000);
  assert.equal(stored.error_rate_threshold, 10);
  assert.deepEqual(stored.alert_emails, { recipients: [], events: [] });
});

test("errorRate counts 5xx and 429 but not cancelled or client errors", () => {
  const rate = errorRate([
    { status: 200, count: 80 },
    { status: 499, count: 10 },
    { status: 400, count: 5 },
    { status: 429, count: 3 },
    { status: 502, count: 2 },
  ]);
  assert.deepEqual(rate, { requests: 100, errors: 5, percent: 5 });
  assert.equal(isErrorRateSpike(rate, RULE), false);
  assert.equal(isErrorRateSpike({ requests: 100, errors: 11, percent: 11 }, RULE), true);
  assert.equal(isErrorRateSpike({ requests: 49, errors: 49, percent: 100 }, RULE), false);
  assert.equal(isErrorRateSpike({ requests: 100, errors: 10, percent: 10 }, RULE), false);
  assert.equal(isErrorRateSpike({ requests: 100, errors: 90, percent: 90 }, { ...RULE, errorRatePercent: 0 }), false);
  assert.deepEqual(errorRate([]), { requests: 0, errors: 0, percent: 0 });
});

test("latencySpike checks the absolute threshold and the baseline factor separately", () => {
  assert.deepEqual(latencySpike(31_000, 0, RULE), { absolute: true, relative: false });
  assert.deepEqual(latencySpike(9_100, 3_000, RULE), { absolute: false, relative: true });
  assert.deepEqual(latencySpike(9_000, 3_000, RULE), { absolute: false, relative: false });
  assert.deepEqual(latencySpike(40_000, 0, { ...RULE, latencyP95Ms: 0 }), { absolute: false, relative: false });
  assert.deepEqual(latencySpike(40_000, 1_000, { ...RULE, latencyFactor: 0 }), { absolute: true, relative: false });
});

test("latencyBaselineWindow covers the 24 hours before the window", () => {
  assert.deepEqual(latencyBaselineWindow(NOW, 15), {
    gte: new Date("2026-10-08T11:45:00.000Z"),
    lt: new Date("2026-10-09T11:45:00.000Z"),
  });
});

test("trafficScopes keeps all traffic plus the busiest named models", () => {
  const scopes = trafficScopes(
    [
      { model: "a", status: 200, count: 5 },
      { model: "b", status: 200, count: 9 },
      { model: "b", status: 500, count: 1 },
      { model: "c", status: 200, count: 7 },
      { model: "", status: 401, count: 20 },
    ],
    2,
  );
  assert.deepEqual(
    scopes.map((scope) => [scope.id, scope.counts.reduce((sum, row) => sum + row.count, 0)]),
    [
      ["all", 42],
      ["model:b", 10],
      ["model:c", 7],
    ],
  );
});

test("nextIncidentState fires once while sustained and again only after recovery plus cooldown", () => {
  const first = nextIncidentState({}, ["all"], NOW);
  assert.deepEqual(first.fire, ["all"]);
  const later = new Date(NOW.getTime() + 3 * HOUR);
  const sustained = nextIncidentState(first.state, ["all"], later);
  assert.deepEqual(sustained.fire, []);
  assert.equal(sustained.state.all, later.toISOString());
  const recovered = nextIncidentState(sustained.state, [], new Date(later.getTime() + MINUTE));
  assert.deepEqual(recovered.state, { all: later.toISOString() });
  const relapse = nextIncidentState(recovered.state, ["all"], new Date(later.getTime() + 30 * MINUTE));
  assert.deepEqual(relapse.fire, []);
  const quiet = new Date(later.getTime() + 30 * MINUTE + TRAFFIC_ALERT_COOLDOWN_MS);
  const expired = nextIncidentState(relapse.state, [], quiet);
  assert.deepEqual(expired.state, {});
  assert.deepEqual(nextIncidentState(expired.state, ["all"], quiet).fire, ["all"]);
});

test("traffic alert messages state the numbers and the rule", () => {
  assert.equal(
    errorRateMessage("", { requests: 500, errors: 117, percent: 23.4 }, RULE),
    "all models: error rate 23.4% (117 of 500 requests were 5xx or 429) over the last 15 minutes; threshold 10%",
  );
  assert.equal(
    latencyMessage("gpt-5", { p95: 45_210, baseline: 11_000, requests: 500 }, { absolute: true, relative: true }, RULE),
    "model gpt-5: p95 latency 45.2 s over the last 15 minutes (500 requests); threshold 30.0 s and 4.1x the p95 of 11.0 s over the previous 24 hours (factor 3)",
  );
});

test("alertMailRecipients returns the recipients only for subscribed events", () => {
  const emails = { recipients: ["ops@example.com"], events: ["latency_spike" as const] };
  assert.deepEqual(alertMailRecipients(emails, "latency_spike"), ["ops@example.com"]);
  assert.deepEqual(alertMailRecipients(emails, "error_rate_spike"), []);
  assert.deepEqual(alertMailRecipients(undefined, "latency_spike"), []);
});

test("runErrorRateAlerts alerts once per scope above the threshold with enough traffic", async () => {
  const { runErrorRateAlerts } = await import("@/worker/alert-checks");
  webhooks(["error_rate_spike"]);
  requests(NOW, "gpt-5", 80, 200);
  requests(NOW, "gpt-5", 15, 502);
  requests(NOW, "gpt-5", 5, 429);
  requests(NOW, "gpt-5", 30, 499);
  requests(NOW, "claude", 100, 200);
  requests(NOW, "tiny", 3, 500);
  requests(NOW, "gpt-5", 200, 500, 1_000, 20 * MINUTE);

  assert.equal(await runErrorRateAlerts(NOW), 1);
  assert.deepEqual(messages, [
    {
      event: "error_rate_spike",
      message: "model gpt-5: error rate 15.4% (20 of 130 requests were 5xx or 429) over the last 15 minutes; threshold 10%",
    },
  ]);
  assert.deepEqual(
    db.audit.filter((a) => a.action === "error_rate_spike").map((a) => [a.objectType, a.objectId]),
    [["model", "gpt-5"]],
  );

  requests(NOW, "claude", 60, 503);
  const next = new Date(NOW.getTime() + MINUTE);
  assert.equal(await runErrorRateAlerts(next), 2);
  assert.deepEqual(messages.slice(1).map((m) => m.message.split(":")[0]).sort(), ["all models", "model claude"]);
  assert.equal(await runErrorRateAlerts(new Date(NOW.getTime() + 2 * MINUTE)), 0);
  assert.equal(messages.length, 3);

  webhooks(["error_rate_spike"], { error_rate_threshold: 0 });
  assert.equal(await runErrorRateAlerts(new Date(NOW.getTime() + 3 * HOUR)), 0);
});

test("runLatencyAlerts compares the window p95 with the threshold and the 24-hour baseline", async () => {
  const { runLatencyAlerts } = await import("@/worker/alert-checks");
  const now = new Date(NOW.getTime() + 2 * DAY);
  webhooks(["latency_spike"], { traffic_min_requests: 20 });
  requests(now, "slow", 30, 200, 40_000);
  requests(now, "drift", 30, 200, 7_000);
  requests(now, "drift", 30, 200, 1_000, 3 * HOUR);
  requests(now, "steady", 30, 200, 5_000);
  requests(now, "steady", 30, 200, 4_000, 3 * HOUR);
  requests(now, "cancel", 30, 499, 90_000);

  assert.equal(await runLatencyAlerts(now), 3);
  assert.deepEqual(messages.map((m) => m.message).sort(), [
    "all models: p95 latency 40.0 s over the last 15 minutes (90 requests); threshold 30.0 s and 10x the p95 of 4.0 s over the previous 24 hours (factor 3)",
    "model drift: p95 latency 7.0 s over the last 15 minutes (30 requests); 7x the p95 of 1.0 s over the previous 24 hours (factor 3)",
    "model slow: p95 latency 40.0 s over the last 15 minutes (30 requests); threshold 30.0 s",
  ]);
  assert.equal(await runLatencyAlerts(new Date(now.getTime() + MINUTE)), 0);

  webhooks(["latency_spike"], { latency_p95_ms: 0, latency_factor: 0 });
  assert.equal(await runLatencyAlerts(new Date(now.getTime() + 3 * HOUR)), 0);
  assert.equal(messages.length, 3);
});
