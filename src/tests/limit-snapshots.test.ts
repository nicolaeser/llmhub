import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { limitSnapshotModel, seedSnapshot, snapshotRows } from "./support/limit-snapshot-fake";
import type { LimitPollAccount, StoredLimitSnapshot, SubscriptionLimits } from "@/types/providers";
import type { ResolvedDeployment } from "@/types/routing";

delete process.env.REDIS_URL;

type FakeLogin = {
  providerId: string;
  account: string;
  plan: string;
  tokens: string;
  expiresAt: Date;
  status: string;
  version: number;
  leaseUntil: Date | null;
};

const logins = new Map<string, FakeLogin>();
const providers = new Map<string, { kind: string; enabled: boolean }>();
const settings = new Map<string, string>();

(globalThis as { prisma?: unknown }).prisma = {
  providerLimitSnapshot: limitSnapshotModel((id) => providers.get(id) ?? null),
  providerLogin: {
    findUnique: async ({ where }: { where: { providerId: string } }) => {
      const row = logins.get(where.providerId);
      return row ? { ...row } : null;
    },
    updateMany: async () => ({ count: 0 }),
  },
  providerConnection: {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const row = providers.get(where.id);
      return row ? { id: where.id, ...row } : null;
    },
    findMany: async () =>
      [...providers.entries()].map(([id, row]) => ({
        id,
        kind: row.kind,
        apiKey: "",
        enabled: row.enabled,
        login: { version: logins.get(id)?.version ?? -1 },
        limitSnapshot: snapshotRows.get(id) ?? null,
      })),
  },
  setting: {
    findUnique: async ({ where }: { where: { key: string } }) => {
      const value = settings.get(where.key);
      return value === undefined ? null : { key: where.key, value };
    },
    findMany: async ({ where }: { where: { key: { in: string[] } } }) =>
      where.key.in.flatMap((key) => (settings.has(key) ? [{ key, value: settings.get(key)! }] : [])),
    create: async ({ data }: { data: { key: string; value: string } }) => {
      if (settings.has(data.key)) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      settings.set(data.key, data.value);
      return { ...data };
    },
    deleteMany: async ({ where }: { where: { key: string; value?: string } }) => {
      const value = settings.get(where.key);
      const matches = value !== undefined && (typeof where.value !== "string" || where.value === value);
      if (matches) settings.delete(where.key);
      return { count: matches ? 1 : 0 };
    },
  },
};

const realFetch = globalThis.fetch;
let upstreamCalls: string[] = [];
let counter = 0;

const HOUR = 3_600_000;
const MINUTE = 60_000;

function usage(used: number, resetIn = 3_600) {
  return Response.json({
    plan_type: "pro",
    rate_limit: {
      allowed: used < 100,
      limit_reached: used >= 100,
      primary_window: { used_percent: used, limit_window_seconds: 18_000, reset_after_seconds: resetIn },
    },
  });
}

function claudeUsage(used: number) {
  return Response.json({
    five_hour: { utilization: used, resets_at: new Date(Date.now() + 3 * HOUR).toISOString() },
    seven_day: { utilization: 20, resets_at: new Date(Date.now() + 100 * HOUR).toISOString() },
    seven_day_opus: { utilization: 70, resets_at: null },
  });
}

function respond(reply: () => Response | Promise<Response>) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    upstreamCalls.push(String(input));
    return reply();
  }) as typeof fetch;
}

function forbidUpstream() {
  globalThis.fetch = (async (input: string | URL | Request) => {
    upstreamCalls.push(String(input));
    throw new Error("snapshot reads must not call the provider");
  }) as typeof fetch;
}

async function account(kind = "codex"): Promise<LimitPollAccount> {
  const { sealTokens } = await import("@/lib/gateway/upstreams/credentials");
  counter += 1;
  const id = `acct-${counter}-${Date.now()}`;
  logins.set(id, {
    providerId: id,
    account: `${id}@example.com`,
    plan: "pro",
    tokens: sealTokens({ access: `access-${id}`, refresh: "r1", accountId: "acct_1", residency: "" }),
    expiresAt: new Date(Date.now() + HOUR),
    status: "active",
    version: 3,
    leaseUntil: null,
  });
  providers.set(id, { kind, enabled: true });
  return { id, kind, apiKey: "", enabled: true, loginVersion: 3 };
}

function limitsAt(usedPercent: number, resetsAt: number | null, now: number, scope = ""): SubscriptionLimits {
  return {
    plan: "pro",
    windows: [
      {
        scope,
        usedPercent,
        windowSeconds: 18_000,
        resetsAt: resetsAt === null ? null : new Date(resetsAt).toISOString(),
        limitReached: usedPercent >= 100,
      },
    ],
    credits: null,
    resetCredits: null,
    extraUsage: null,
    fetchedAt: new Date(now).toISOString(),
  };
}

function stored(change: Partial<StoredLimitSnapshot> = {}): StoredLimitSnapshot {
  return {
    providerId: "p",
    limits: null,
    resets: null,
    resetsAt: null,
    error: "",
    fetchedAt: null,
    checkedAt: null,
    nextAt: 0,
    retryAt: null,
    failures: 0,
    loginVersion: 3,
    leaseUntil: null,
    version: 1,
    ...change,
  };
}

beforeEach(() => {
  upstreamCalls = [];
  snapshotRows.clear();
  settings.clear();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("accounts are polled every five minutes with jitter and right after an exhausted window resets", async () => {
  const { nextPollAt, LIMITS_POLL_MS, MIN_POLL_GAP_MS, RESET_GRACE_MS } = await import(
    "@/lib/gateway/upstreams/limit-store"
  );
  const now = 1_000_000_000_000;
  assert.equal(nextPollAt("codex", null, now, () => 0), now + Math.round(LIMITS_POLL_MS * 0.85));
  assert.equal(nextPollAt("codex", null, now, () => 0.5), now + LIMITS_POLL_MS);
  assert.ok(nextPollAt("codex", null, now, () => 0.999) <= now + LIMITS_POLL_MS * 1.15);
  assert.equal(nextPollAt("codex", limitsAt(40, now + 2 * MINUTE, now), now, () => 0.5), now + LIMITS_POLL_MS);
  assert.equal(nextPollAt("codex", limitsAt(100, now + 2 * MINUTE, now), now, () => 0), now + 2 * MINUTE + RESET_GRACE_MS);
  assert.equal(nextPollAt("codex", limitsAt(100, now + 10_000, now), now, () => 0), now + MIN_POLL_GAP_MS);
  assert.equal(nextPollAt("codex", limitsAt(100, now + 2 * HOUR, now), now, () => 0.5), now + LIMITS_POLL_MS);
  assert.equal(nextPollAt("codex", limitsAt(100, now + 2 * MINUTE, now, "Opus"), now, () => 0.5), now + LIMITS_POLL_MS);
  assert.equal(nextPollAt("codex", limitsAt(100, null, now), now, () => 0.5), now + LIMITS_POLL_MS);
});

test("Claude accounts are polled every thirty minutes and skip the after-reset check while traffic reports the limits", async () => {
  const { nextPollAt, CLAUDE_POLL_MS, RESET_GRACE_MS } = await import("@/lib/gateway/upstreams/limit-store");
  const now = 1_000_000_000_000;
  assert.equal(CLAUDE_POLL_MS, 30 * MINUTE);
  assert.equal(nextPollAt("claude", null, now, () => 0.5), now + 30 * MINUTE);
  assert.equal(nextPollAt("claude", null, now, () => 0), now + Math.round(30 * MINUTE * 0.85));
  assert.equal(nextPollAt("claude", null, now, () => 1), now + Math.round(30 * MINUTE * 1.15));
  const exhausted = limitsAt(100, now + 2 * MINUTE, now);
  assert.equal(nextPollAt("claude", exhausted, now, () => 0), now + 2 * MINUTE + RESET_GRACE_MS);
  const observed = { ...exhausted, observedAt: new Date(now - 5 * MINUTE).toISOString() };
  assert.equal(nextPollAt("claude", observed, now, () => 0.5), now + 30 * MINUTE);
  const stale = { ...exhausted, observedAt: new Date(now - 40 * MINUTE).toISOString() };
  assert.equal(nextPollAt("claude", stale, now, () => 0), now + 2 * MINUTE + RESET_GRACE_MS);
});

test("failed checks back off from one minute to thirty, sign-in failures start at five, and a 429 waits for Retry-After", async () => {
  const { failureDelay, LIMITS_POLL_MS, MAX_BACKOFF_MS } = await import("@/lib/gateway/upstreams/limit-store");
  const half = () => 0.5;
  const failed = { code: "UPSTREAM_FAILED" as const, retryAfterMs: null };
  assert.deepEqual(
    [1, 2, 3, 6, 12].map((failures) => failureDelay(failed, failures, half)),
    [MINUTE, 2 * MINUTE, 4 * MINUTE, MAX_BACKOFF_MS, MAX_BACKOFF_MS],
  );
  assert.equal(failureDelay({ code: "UPSTREAM_AUTH", retryAfterMs: null }, 1, half), 5 * MINUTE);
  assert.equal(failureDelay({ code: "SIGN_IN_EXPIRED", retryAfterMs: null }, 2, half), 10 * MINUTE);
  const zero = () => 0;
  assert.equal(failureDelay({ code: "UPSTREAM_RATE_LIMITED", retryAfterMs: 2 * HOUR }, 1, zero), 2 * HOUR);
  assert.equal(failureDelay({ code: "UPSTREAM_RATE_LIMITED", retryAfterMs: 30_000 }, 1, zero), 15 * MINUTE);
  assert.ok(LIMITS_POLL_MS < 15 * MINUTE);
  assert.equal(failureDelay({ code: "UPSTREAM_RATE_LIMITED", retryAfterMs: null }, 1, zero), 15 * MINUTE);
});

test("consecutive 429s wait 15, 30, 60, then 120 minutes, never less than Retry-After, with jitter on top", async () => {
  const { failureDelay, rateLimitWait } = await import("@/lib/gateway/upstreams/limit-store");
  assert.deepEqual(
    [1, 2, 3, 4, 5, 9].map((failures) => rateLimitWait(failures, null)),
    [15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 2 * HOUR, 2 * HOUR],
  );
  assert.equal(rateLimitWait(1, 0), 15 * MINUTE);
  assert.equal(rateLimitWait(2, 3 * HOUR), 3 * HOUR);
  const limited = { code: "UPSTREAM_RATE_LIMITED" as const, retryAfterMs: null };
  assert.equal(failureDelay(limited, 4, () => 1), 2 * HOUR + 12 * MINUTE);
  assert.equal(failureDelay(limited, 2, () => 0.5), 31 * MINUTE + 30_000);
});

test("an account is due when its time came, never during a Retry-After, and again after a new sign-in fixed a failure", async () => {
  const { pollDue } = await import("@/lib/gateway/upstreams/limit-store");
  const now = 2_000_000;
  assert.equal(pollDue(null, 3, now), true);
  assert.equal(pollDue(stored({ nextAt: now + 1 }), 3, now), false);
  assert.equal(pollDue(stored({ nextAt: now }), 3, now), true);
  assert.equal(pollDue(stored({ nextAt: now - 1, retryAt: now + 1 }), 3, now), false);
  assert.equal(pollDue(stored({ nextAt: now + HOUR, failures: 2, loginVersion: 2 }), 3, now), true);
  assert.equal(pollDue(stored({ nextAt: now + HOUR, failures: 0, loginVersion: 2 }), 3, now), false);
  assert.equal(pollDue(stored({ nextAt: now + HOUR, failures: 2, loginVersion: 3 }), 3, now), false);
});

test("two concurrent refreshers of one account reach the provider once and share the stored snapshot", async () => {
  const { refreshLimits } = await import("@/lib/gateway/upstreams/limit-store");
  const target = await account();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  respond(async () => {
    await gate;
    return usage(42);
  });
  const now = Date.now();
  const first = refreshLimits(target, { kind: "scheduled" }, { now, random: () => 0.5 });
  const second = refreshLimits(target, { kind: "scheduled" }, { now, random: () => 0.5 });
  const third = refreshLimits(target, { kind: "manual" }, { now, random: () => 0.5 });
  setTimeout(release, 20);
  const results = await Promise.all([first, second, third]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["busy", "busy", "fetched"]);
  assert.equal(upstreamCalls.length, 1);
  assert.equal(results[2]?.snapshot?.limits?.windows[0]?.usedPercent, 42);
  const row = snapshotRows.get(target.id)!;
  assert.equal(row.leaseUntil, null);
  assert.equal(row.version, 1);
  assert.equal((row.nextAt as Date).getTime(), now + 5 * MINUTE);
  const { limitsSnapshot } = await import("@/lib/gateway/upstreams/subscription-limits");
  assert.equal(limitsSnapshot(target.id)?.windows[0]?.usedPercent, 42);
});

test("manual refreshes reach the provider at most once a minute and return the stored snapshot otherwise", async () => {
  const { refreshLimits } = await import("@/lib/gateway/upstreams/limit-store");
  const target = await account();
  respond(() => usage(10));
  const now = Date.now();
  assert.equal((await refreshLimits(target, { kind: "manual" }, { now })).status, "fetched");
  const again = await refreshLimits(target, { kind: "manual" }, { now: now + 30_000 });
  assert.equal(again.status, "skipped");
  assert.equal(again.snapshot?.limits?.windows[0]?.usedPercent, 10);
  assert.equal((await refreshLimits(target, { kind: "scheduled" }, { now: now + 30_000 })).status, "skipped");
  assert.equal(upstreamCalls.length, 1);
  assert.equal((await refreshLimits(target, { kind: "manual" }, { now: now + MINUTE })).status, "fetched");
  assert.equal(upstreamCalls.length, 2);
});

test("a 429 stores its Retry-After and blocks every refresh until then, keeping the last limits", async () => {
  const { refreshLimits } = await import("@/lib/gateway/upstreams/limit-store");
  const target = await account();
  respond(() => usage(55));
  const now = Date.now();
  await refreshLimits(target, { kind: "scheduled" }, { now, random: () => 0.5 });
  respond(() => new Response("", { status: 429, headers: { "retry-after": "1200" } }));
  const limited = await refreshLimits(target, { kind: "scheduled" }, { now: now + 6 * MINUTE, random: () => 0 });
  assert.equal(limited.failure?.code, "UPSTREAM_RATE_LIMITED");
  assert.equal(limited.snapshot?.error, "UPSTREAM_RATE_LIMITED");
  assert.equal(limited.snapshot?.retryAt, now + 26 * MINUTE);
  assert.equal(limited.snapshot?.nextAt, now + 26 * MINUTE);
  assert.equal(limited.snapshot?.limits?.windows[0]?.usedPercent, 55);
  assert.equal(limited.snapshot?.failures, 1);
  for (const at of [now + 8 * MINUTE, now + 20 * MINUTE]) {
    assert.equal((await refreshLimits(target, { kind: "manual" }, { now: at })).status, "skipped");
    assert.equal((await refreshLimits(target, { kind: "scheduled" }, { now: at })).status, "skipped");
    assert.equal((await refreshLimits(target, { kind: "fresh", maxAgeMs: 0 }, { now: at })).status, "skipped");
  }
  assert.equal(upstreamCalls.length, 2);
  respond(() => usage(60));
  const recovered = await refreshLimits(target, { kind: "scheduled" }, { now: now + 27 * MINUTE });
  assert.equal(recovered.status, "fetched");
  assert.equal(recovered.snapshot?.error, "");
  assert.equal(recovered.snapshot?.failures, 0);
  assert.equal(recovered.snapshot?.retryAt, null);
});

test("the 429 backoff escalates on every rate-limited usage read and a successful read resets it", async () => {
  const { refreshLimits } = await import("@/lib/gateway/upstreams/limit-store");
  const target = await account("claude");
  const now = Date.now();
  respond(() => new Response("", { status: 429, headers: { "retry-after": "0" } }));
  let at = now;
  const waits: number[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await refreshLimits(target, { kind: "scheduled" }, { now: at, random: () => 0 });
    assert.equal(result.status, "fetched");
    waits.push(result.snapshot!.retryAt! - at);
    assert.equal(result.snapshot?.nextAt, result.snapshot?.retryAt);
    assert.equal((await refreshLimits(target, { kind: "manual" }, { now: result.snapshot!.retryAt! - 1 })).status, "skipped");
    at = result.snapshot!.retryAt!;
  }
  assert.deepEqual(waits, [15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 2 * HOUR]);
  assert.equal(upstreamCalls.length, 5);
  respond(() => claudeUsage(30));
  const recovered = await refreshLimits(target, { kind: "scheduled" }, { now: at, random: () => 0.5 });
  assert.equal(recovered.snapshot?.error, "");
  assert.equal(recovered.snapshot?.failures, 0);
  assert.equal(recovered.snapshot?.retryAt, null);
  assert.equal(recovered.snapshot?.nextAt, at + 30 * MINUTE);
  respond(() => new Response("", { status: 503 }));
  const failed = await refreshLimits(target, { kind: "scheduled" }, { now: at + 30 * MINUTE, random: () => 0.5 });
  assert.equal(failed.snapshot?.failures, 1);
  respond(() => new Response("", { status: 429 }));
  const limited = await refreshLimits(target, { kind: "scheduled" }, { now: at + 32 * MINUTE, random: () => 0 });
  assert.equal(limited.snapshot?.failures, 1);
  assert.equal(limited.snapshot?.retryAt, at + 47 * MINUTE);
});

test("Claude manual refreshes reach Anthropic at most every five minutes and never during a 429 block", async () => {
  const { refreshLimits, CLAUDE_MANUAL_REFRESH_GAP_MS } = await import("@/lib/gateway/upstreams/limit-store");
  const target = await account("claude");
  respond(() => claudeUsage(12));
  const now = Date.now();
  assert.equal((await refreshLimits(target, { kind: "manual" }, { now })).status, "fetched");
  assert.equal((await refreshLimits(target, { kind: "manual" }, { now: now + 2 * MINUTE })).status, "skipped");
  assert.equal((await refreshLimits(target, { kind: "manual" }, { now: now + 4 * MINUTE + 59_000 })).status, "skipped");
  assert.equal(upstreamCalls.length, 1);
  respond(() => new Response("", { status: 429 }));
  const limited = await refreshLimits(target, { kind: "manual" }, { now: now + CLAUDE_MANUAL_REFRESH_GAP_MS });
  assert.equal(limited.failure?.code, "UPSTREAM_RATE_LIMITED");
  assert.equal(upstreamCalls.length, 2);
  assert.equal(limited.snapshot?.retryAt, now + 20 * MINUTE);
  const held = await refreshLimits(target, { kind: "manual" }, { now: now + 20 * MINUTE - 1 });
  assert.equal(held.status, "skipped");
  assert.equal(held.snapshot?.limits?.windows[0]?.usedPercent, 12);
  assert.equal(upstreamCalls.length, 2);
});

test("failures back off, and a renewed sign-in makes the account due again at once", async () => {
  const { refreshLimits } = await import("@/lib/gateway/upstreams/limit-store");
  const target = await account();
  respond(() => new Response("", { status: 401 }));
  const now = Date.now();
  const failed = await refreshLimits(target, { kind: "scheduled" }, { now, random: () => 0.5 });
  assert.equal(failed.snapshot?.error, "UPSTREAM_AUTH");
  assert.equal(failed.snapshot?.nextAt, now + 5 * MINUTE);
  assert.equal((await refreshLimits(target, { kind: "scheduled" }, { now: now + MINUTE })).status, "skipped");
  respond(() => usage(5));
  const renewed = await refreshLimits({ ...target, loginVersion: 4 }, { kind: "scheduled" }, { now: now + MINUTE });
  assert.equal(renewed.status, "fetched");
  assert.equal(renewed.snapshot?.loginVersion, 4);
  assert.equal(renewed.snapshot?.error, "");
});

test("console reads, live reads, and routing hydration never call the provider", async () => {
  const { hydrateLimits, readLimitSnapshot, readLimitSnapshots } = await import("@/lib/gateway/upstreams/limit-store");
  const { limitsSnapshot } = await import("@/lib/gateway/upstreams/subscription-limits");
  const target = await account();
  const unchecked = await account();
  const now = Date.now();
  seedSnapshot(target.id, { limits: limitsAt(70, now + HOUR, now), fetchedAt: new Date(now), checkedAt: new Date(now), version: 4 });
  seedSnapshot(unchecked.id);
  forbidUpstream();
  const [item] = await readLimitSnapshots([target.id, unchecked.id], now);
  assert.equal(item?.id, target.id);
  assert.equal(item?.version, 4);
  assert.equal(item?.limits?.windows[0]?.usedPercent, 70);
  assert.equal((await readLimitSnapshots([unchecked.id], now)).length, 0);
  assert.equal((await readLimitSnapshot(target.id, now))?.checkedAt, new Date(now).toISOString());
  assert.equal(await readLimitSnapshot(unchecked.id, now), null);
  await hydrateLimits([target.id, unchecked.id], now);
  assert.equal(limitsSnapshot(target.id)?.windows[0]?.usedPercent, 70);
  assert.equal(upstreamCalls.length, 0);
});

test("fresh reads reuse a recent snapshot and refetch through the lease when it is too old", async () => {
  const { freshLimits } = await import("@/lib/gateway/upstreams/limit-store");
  const target = await account();
  const now = Date.now();
  seedSnapshot(target.id, { limits: limitsAt(30, null, now - 5_000), fetchedAt: new Date(now - 5_000), checkedAt: new Date(now - 5_000) });
  forbidUpstream();
  assert.equal((await freshLimits(target, 10_000))?.windows[0]?.usedPercent, 30);
  respond(() => usage(80));
  assert.equal((await freshLimits(target, 1_000))?.windows[0]?.usedPercent, 80);
  assert.equal(upstreamCalls.length, 1);
  respond(() => new Response("", { status: 503 }));
  await assert.rejects(freshLimits(target, 0), { message: "UPSTREAM_FAILED" });
});

test("the snapshot view adds the pending reset claim and keeps Codex reset counts from the usage read", async () => {
  const { snapshotView } = await import("@/lib/gateway/upstreams/limit-store");
  const { resetStateKey, RETRY_WINDOW_MS } = await import("@/lib/gateway/upstreams/reset-state");
  const now = Date.now();
  const limits = { ...limitsAt(100, now + HOUR, now), resetCredits: { available: 2, applicable: 1 } };
  const view = { available: 1, applicable: 0, credits: [{ id: "c1", title: "Reset", expiresAt: null }], checkedAt: null };
  const base = stored({ providerId: "codex-1", limits, resets: view, checkedAt: now, nextAt: now + MINUTE, retryAt: now - 1 });
  const plain = snapshotView("codex", true, base, null, now);
  assert.equal(plain.limits?.resetCredits?.available, 2);
  assert.equal(plain.limits?.resetCredits?.applicable, 1);
  assert.equal(plain.limits?.resetCredits?.canRedeem, true);
  assert.deepEqual(plain.limits?.resetCredits?.credits, view.credits);
  assert.equal(plain.retryAt, null);
  assert.equal(plain.nextAt, new Date(now + MINUTE).toISOString());
  assert.equal(snapshotView("codex", false, base, null, now).nextAt, null);
  const pending = { kind: "codex" as const, requestId: "req-1", startedAt: now - RETRY_WINDOW_MS - 1, attempts: 1, trigger: "manual" as const, actor: "u" };
  const claimed = snapshotView("codex", true, base, { pending, lastAutoAt: 0 }, now);
  assert.equal(claimed.limits?.resetCredits?.pending?.retryable, false);
  assert.equal(claimed.limits?.resetCredits?.canRedeem, false);
  const claude = snapshotView("claude", true, { ...base, limits: { ...limits, resetCredits: null }, resets: null }, { pending, lastAutoAt: 0 }, now);
  assert.deepEqual(claude.limits?.resetCredits, {
    available: 0,
    applicable: 0,
    checkedAt: null,
    pending: { startedAt: new Date(pending.startedAt).toISOString(), retryUntil: new Date(now - 1).toISOString(), retryable: false },
    canRedeem: false,
  });
  assert.equal(resetStateKey("x"), "provider_reset:x");
});

test("a reset claim, a stored reset view, and a nudge bump or reschedule the snapshot without calling the provider", async () => {
  const { nudgeLimits, storeResetView, touchLimitSnapshot, expireResetView } = await import(
    "@/lib/gateway/upstreams/limit-store"
  );
  const target = await account();
  const now = Date.now();
  seedSnapshot(target.id, { checkedAt: new Date(now - 2 * MINUTE), nextAt: new Date(now + 4 * MINUTE), version: 2 });
  forbidUpstream();
  await touchLimitSnapshot(target.id);
  assert.equal(snapshotRows.get(target.id)?.version, 3);
  await storeResetView(target.id, { available: 1, applicable: 1 }, now);
  assert.equal(snapshotRows.get(target.id)?.version, 4);
  assert.deepEqual(snapshotRows.get(target.id)?.resets, { available: 1, applicable: 1 });
  await expireResetView(target.id);
  assert.equal(snapshotRows.get(target.id)?.resetsAt, null);
  nudgeLimits(target.id, "codex", now);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((snapshotRows.get(target.id)?.nextAt as Date).getTime(), now);
  snapshotRows.get(target.id)!.nextAt = new Date(now + 4 * MINUTE);
  nudgeLimits(target.id, "codex", now + 1_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((snapshotRows.get(target.id)?.nextAt as Date).getTime(), now + 4 * MINUTE);
  assert.equal(upstreamCalls.length, 0);
});

test("forgetting an account clears its error and backoff, makes it due at once, and keeps routing off the old limits", async () => {
  const { freshLimits, hydrateLimits, pollDue, readStoredSnapshot } = await import("@/lib/gateway/upstreams/limit-store");
  const { forgetLimits, limitsSnapshot, rememberLimits } = await import("@/lib/gateway/upstreams/subscription-limits");
  const target = await account();
  const held = await account();
  const now = Date.now();
  const exhausted = limitsAt(100, now + HOUR, now - 10 * MINUTE);
  seedSnapshot(target.id, {
    limits: exhausted,
    error: "UPSTREAM_FAILED",
    failures: 4,
    fetchedAt: new Date(now - 10 * MINUTE),
    checkedAt: new Date(now - MINUTE),
    nextAt: new Date(now + 30 * MINUTE),
    version: 5,
  });
  seedSnapshot(held.id, {
    limits: exhausted,
    error: "UPSTREAM_RATE_LIMITED",
    failures: 1,
    fetchedAt: new Date(now - 10 * MINUTE),
    checkedAt: new Date(now - MINUTE),
    retryAt: new Date(now + 20 * MINUTE),
    nextAt: new Date(now + 20 * MINUTE),
  });
  rememberLimits(target.id, exhausted);
  forbidUpstream();
  await forgetLimits(target.id, now);
  await forgetLimits(held.id, now);
  await forgetLimits("missing-account", now);
  const forgotten = await readStoredSnapshot(target.id);
  assert.equal(forgotten?.error, "");
  assert.equal(forgotten?.failures, 0);
  assert.equal(forgotten?.nextAt, now);
  assert.equal(forgotten?.fetchedAt, null);
  assert.equal(forgotten?.version, 6);
  assert.equal(forgotten?.limits?.windows[0]?.usedPercent, 100);
  assert.equal(pollDue(forgotten, target.loginVersion, now), true);
  assert.equal(limitsSnapshot(target.id), null);
  await hydrateLimits([target.id], now + MINUTE);
  assert.equal(limitsSnapshot(target.id), null);
  const waiting = await readStoredSnapshot(held.id);
  assert.equal(waiting?.retryAt, now + 20 * MINUTE);
  assert.equal(pollDue(waiting, held.loginVersion, now), false);
  assert.equal(upstreamCalls.length, 0);
  respond(() => usage(10));
  assert.equal((await freshLimits(target, 10 * MINUTE))?.windows[0]?.usedPercent, 10);
  assert.equal(limitsSnapshot(target.id)?.windows[0]?.usedPercent, 10);
  assert.equal(upstreamCalls.length, 1);
});

function claudeSnapshotLimits(fetchedAt: number): SubscriptionLimits {
  return {
    plan: "max",
    windows: [
      { scope: "", usedPercent: 10, windowSeconds: 18_000, resetsAt: new Date(fetchedAt + 3 * HOUR).toISOString(), limitReached: false },
      { scope: "", usedPercent: 20, windowSeconds: 604_800, resetsAt: new Date(fetchedAt + 90 * HOUR).toISOString(), limitReached: false },
      { scope: "Opus", usedPercent: 70, windowSeconds: 604_800, resetsAt: null, limitReached: false },
    ],
    credits: null,
    resetCredits: null,
    extraUsage: { usedCents: 300, limitCents: 2_000, percent: 15 },
    fetchedAt: new Date(fetchedAt).toISOString(),
  };
}

function unifiedHeaders(fiveHour: number, weekly: number, now: number, status = "allowed"): Headers {
  return new Headers({
    "anthropic-ratelimit-unified-status": status,
    "anthropic-ratelimit-unified-representative-claim": "five_hour",
    "anthropic-ratelimit-unified-reset": String(Math.floor((now + 3 * HOUR) / 1000)),
    "anthropic-ratelimit-unified-5h-utilization": String(fiveHour),
    "anthropic-ratelimit-unified-5h-reset": String(Math.floor((now + 3 * HOUR) / 1000)),
    "anthropic-ratelimit-unified-5h-status": status,
    "anthropic-ratelimit-unified-7d-utilization": String(weekly),
    "anthropic-ratelimit-unified-7d-reset": String(Math.floor((now + 90 * HOUR) / 1000)),
    "anthropic-ratelimit-unified-7d-status": "allowed",
  });
}

async function seededClaude(now: number, change: Record<string, unknown> = {}): Promise<LimitPollAccount> {
  const target = await account("claude");
  seedSnapshot(target.id, {
    limits: claudeSnapshotLimits(now - 10 * MINUTE),
    fetchedAt: new Date(now - 10 * MINUTE),
    checkedAt: new Date(now - 10 * MINUTE),
    nextAt: new Date(now + 20 * MINUTE),
    loginVersion: 3,
    version: 1,
    ...change,
  });
  return target;
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 20; tick++) await new Promise((resolve) => setImmediate(resolve));
}

test("traffic headers update the plan windows, keep model limits and extra usage, and push the full poll out", async () => {
  const { observeClaudeLimits, readStoredSnapshot, CLAUDE_POLL_MS } = await import("@/lib/gateway/upstreams/limit-store");
  const { limitsSnapshot } = await import("@/lib/gateway/upstreams/subscription-limits");
  const now = Date.now();
  const target = await seededClaude(now);
  forbidUpstream();
  assert.equal(await observeClaudeLimits(target.id, unifiedHeaders(0.42, 0.25, now), now), true);
  const stored = await readStoredSnapshot(target.id);
  assert.equal(stored?.version, 2);
  assert.equal(stored?.fetchedAt, now - 10 * MINUTE);
  assert.equal(stored?.nextAt, now + CLAUDE_POLL_MS);
  assert.equal(stored?.limits?.plan, "max");
  assert.equal(stored?.limits?.observedAt, new Date(now).toISOString());
  assert.deepEqual(
    stored?.limits?.windows.map((window) => [window.scope, window.usedPercent]),
    [["", 42], ["", 25], ["Opus", 70]],
  );
  assert.deepEqual(stored?.limits?.extraUsage, { usedCents: 300, limitCents: 2_000, percent: 15 });
  assert.equal(limitsSnapshot(target.id)?.windows[0]?.usedPercent, 42);
  assert.equal(await observeClaudeLimits(target.id, new Headers({ "content-type": "application/json" }), now), false);
  const later = await seededClaude(now, { fetchedAt: new Date(now - 110 * MINUTE), nextAt: new Date(now + MINUTE) });
  await observeClaudeLimits(later.id, unifiedHeaders(0.5, 0.3, now), now);
  assert.equal((await readStoredSnapshot(later.id))?.nextAt, now + 10 * MINUTE);
  const failing = await seededClaude(now, { failures: 2, error: "UPSTREAM_FAILED", nextAt: new Date(now + MINUTE) });
  await observeClaudeLimits(failing.id, unifiedHeaders(0.5, 0.3, now), now);
  assert.equal((await readStoredSnapshot(failing.id))?.nextAt, now + MINUTE);
  assert.equal(upstreamCalls.length, 0);
});

test("traffic header writes are throttled per account and skipped when nothing moved", async () => {
  const { observeClaudeLimits, readStoredSnapshot, OBSERVED_REFRESH_MS } = await import("@/lib/gateway/upstreams/limit-store");
  const { limitsSnapshot } = await import("@/lib/gateway/upstreams/subscription-limits");
  const now = Date.now();
  const target = await seededClaude(now);
  forbidUpstream();
  assert.equal(await observeClaudeLimits(target.id, unifiedHeaders(0.4, 0.2, now), now), true);
  assert.equal(await observeClaudeLimits(target.id, unifiedHeaders(0.45, 0.2, now), now + 10_000), false);
  assert.equal((await readStoredSnapshot(target.id))?.version, 2);
  assert.equal(limitsSnapshot(target.id)?.windows[0]?.usedPercent, 45);
  assert.equal(await observeClaudeLimits(target.id, unifiedHeaders(0.404, 0.2, now), now + 40_000), false);
  assert.equal(await observeClaudeLimits(target.id, unifiedHeaders(0.47, 0.2, now), now + 50_000), true);
  assert.equal((await readStoredSnapshot(target.id))?.limits?.windows[0]?.usedPercent, 47);
  assert.equal(await observeClaudeLimits(target.id, unifiedHeaders(1, 0.2, now, "rejected"), now + 55_000), true);
  const rejected = await readStoredSnapshot(target.id);
  assert.equal(rejected?.version, 4);
  assert.equal(rejected?.limits?.windows[0]?.limitReached, true);
  assert.equal(limitsSnapshot(target.id)?.windows[0]?.limitReached, true);
  assert.equal(await observeClaudeLimits(target.id, unifiedHeaders(1, 0.2, now, "rejected"), now + 2 * MINUTE), false);
  assert.equal(
    await observeClaudeLimits(target.id, unifiedHeaders(1, 0.2, now, "rejected"), now + 55_000 + OBSERVED_REFRESH_MS),
    true,
  );
  assert.equal((await readStoredSnapshot(target.id))?.version, 5);
  assert.equal(upstreamCalls.length, 0);
});

test("header writes keep a forgotten snapshot off routing and build plan windows for an account without limits", async () => {
  const { observeClaudeLimits, readStoredSnapshot, storeObservedLimits, hydrateLimits } = await import(
    "@/lib/gateway/upstreams/limit-store"
  );
  const { claudeHeaderWindows } = await import("@/lib/gateway/upstreams/observed-limits");
  const { limitsSnapshot } = await import("@/lib/gateway/upstreams/subscription-limits");
  const now = Date.now();
  const forgotten = await seededClaude(now, { fetchedAt: null, nextAt: new Date(now) });
  forbidUpstream();
  await observeClaudeLimits(forgotten.id, unifiedHeaders(0.6, 0.3, now), now);
  const kept = await readStoredSnapshot(forgotten.id);
  assert.equal(kept?.limits?.windows[0]?.usedPercent, 60);
  assert.equal(kept?.nextAt, now);
  assert.equal(kept?.fetchedAt, null);
  await hydrateLimits([forgotten.id], now + MINUTE);
  assert.equal(limitsSnapshot(forgotten.id), null);
  const fresh = await account("claude");
  seedSnapshot(fresh.id, { checkedAt: new Date(now), nextAt: new Date(now + HOUR), error: "UPSTREAM_RATE_LIMITED", failures: 1 });
  assert.equal(await storeObservedLimits(fresh.id, claudeHeaderWindows(unifiedHeaders(0.1, 0.05, now)), now), true);
  const built = await readStoredSnapshot(fresh.id);
  assert.equal(built?.limits?.plan, "");
  assert.deepEqual(built?.limits?.windows.map((window) => window.usedPercent), [10, 5]);
  assert.equal(built?.error, "UPSTREAM_RATE_LIMITED");
  assert.equal(built?.nextAt, now + HOUR);
  assert.equal(await storeObservedLimits("missing-account", [], now), false);
});

test("header data serves fresh reads, and a 429 that carried the headers does not nudge the poll", async () => {
  const { freshLimits, nudgeLimits, observeClaudeLimits, readStoredSnapshot } = await import(
    "@/lib/gateway/upstreams/limit-store"
  );
  const now = Date.now();
  const target = await seededClaude(now);
  forbidUpstream();
  await observeClaudeLimits(target.id, unifiedHeaders(1, 0.3, now, "rejected"), now);
  assert.equal((await freshLimits(target, 60_000))?.windows[0]?.limitReached, true);
  nudgeLimits(target.id, "claude", now + 1_000);
  await settle();
  assert.equal((await readStoredSnapshot(target.id))?.nextAt, now + 30 * MINUTE);
  const recent = await seededClaude(now, { checkedAt: new Date(now - 3 * MINUTE), nextAt: new Date(now + 20 * MINUTE) });
  nudgeLimits(recent.id, "claude", now);
  await settle();
  assert.equal((await readStoredSnapshot(recent.id))?.nextAt, now + 20 * MINUTE);
  const quiet = await seededClaude(now, { nextAt: new Date(now + 20 * MINUTE) });
  nudgeLimits(quiet.id, "claude", now);
  await settle();
  assert.equal((await readStoredSnapshot(quiet.id))?.nextAt, now);
  assert.equal(upstreamCalls.length, 0);
});

test("gateway responses from a Claude account feed its limits on success and on 429", async () => {
  const { proxyJson } = await import("@/lib/gateway/dispatch/upstream");
  const { readStoredSnapshot } = await import("@/lib/gateway/upstreams/limit-store");
  const now = Date.now();
  const target = await seededClaude(now);
  const dep = {
    id: `dep-${target.id}`,
    kind: "claude",
    base_url: "",
    model: "claude-sonnet-4-5",
    weight: 1,
    cost_input_per_1k: 0,
    cost_output_per_1k: 0,
    provider_id: target.id,
    provider: { id: target.id, kind: "claude" },
  } as unknown as ResolvedDeployment;
  const auth = { key: "access", headers: {} };
  let headers = unifiedHeaders(0.33, 0.21, now);
  let status = 200;
  respond(() =>
    Response.json(status === 200 ? { type: "message", content: [], usage: {} } : { type: "error" }, { status, headers }),
  );
  await proxyJson({ dep, auth, path: "/v1/messages", body: { model: "claude-sonnet-4-5", messages: [] } });
  await settle();
  assert.equal((await readStoredSnapshot(target.id))?.limits?.windows[0]?.usedPercent, 33);
  status = 429;
  headers = unifiedHeaders(1, 0.21, now, "rejected");
  const limited = await proxyJson({ dep, auth, path: "/v1/messages", body: { model: "claude-sonnet-4-5", messages: [] } });
  assert.equal(limited.status, 429);
  await settle();
  assert.equal((await readStoredSnapshot(target.id))?.limits?.windows[0]?.limitReached, true);
  const other = { ...dep, kind: "codex", provider: { id: target.id, kind: "codex" } } as unknown as ResolvedDeployment;
  headers = unifiedHeaders(0.05, 0.05, now);
  status = 200;
  await proxyJson({ dep: other, auth, path: "/v1/messages", body: { model: "x", messages: [] } }).catch(() => null);
  await settle();
  assert.equal((await readStoredSnapshot(target.id))?.limits?.windows[0]?.usedPercent, 100);
});

test("a sweep reads at most four Claude accounts and spreads the rest over the next sweeps", async () => {
  const { refreshDueLimits } = await import("@/lib/providers/limit-refresh");
  providers.clear();
  logins.clear();
  const claude = await Promise.all(Array.from({ length: 6 }, () => account("claude")));
  const codex = await Promise.all(Array.from({ length: 2 }, () => account("codex")));
  respond(() => (upstreamCalls.at(-1)?.includes("anthropic") ? claudeUsage(5) : usage(5)));
  const now = Date.now();
  const claudeCalls = () => upstreamCalls.filter((url) => url.includes("api.anthropic.com")).length;
  const polls: number[] = [];
  const reads: number[] = [];
  for (let sweep = 0; sweep < 4; sweep++) {
    const before = claudeCalls();
    polls.push(await refreshDueLimits(now + sweep * MINUTE));
    reads.push(claudeCalls() - before);
  }
  assert.deepEqual(polls, [6, 2, 0, 0]);
  assert.deepEqual(reads, [4, 4, 4, 0]);
  assert.equal(upstreamCalls.filter((url) => url.includes("cedar_ember=1")).length, 6);
  assert.ok(claude.every((item) => snapshotRows.get(item.id)?.fetchedAt));
  assert.ok(codex.every((item) => snapshotRows.get(item.id)?.fetchedAt));
});
