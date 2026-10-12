import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import {
  anomalyLookbackDays,
  claimCooldown,
  historyDays,
  isSpendAnomaly,
  nextAnomalyState,
  sameHourWindows,
} from "@/lib/gateway/alert-rules";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-10-09T12:00:00.000Z");

type Range = { gte?: Date; gt?: Date; lte?: Date; lt?: Date };
type Event = { keyId: string; projectId: string; cost: number; createdAt: Date };

const db = {
  settings: new Map<string, string>(),
  events: [] as Event[],
  keys: [] as { id: string; keyAlias: string; prefix: string; createdAt: Date; expiresAt: Date | null; blocked: boolean }[],
  projects: [] as { id: string; alias: string; createdAt: Date }[],
  audit: [] as { action: string; objectId: string }[],
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
