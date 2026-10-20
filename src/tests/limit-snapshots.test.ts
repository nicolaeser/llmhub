import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { limitSnapshotModel, seedSnapshot, snapshotRows } from "./support/limit-snapshot-fake";
import type { LimitPollAccount, StoredLimitSnapshot, SubscriptionLimits } from "@/types/providers";

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
  },
  setting: {
    findUnique: async ({ where }: { where: { key: string } }) => {
      const value = settings.get(where.key);
      return value === undefined ? null : { key: where.key, value };
    },
    findMany: async ({ where }: { where: { key: { in: string[] } } }) =>
      where.key.in.flatMap((key) => (settings.has(key) ? [{ key, value: settings.get(key)! }] : [])),
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
  assert.equal(nextPollAt(null, now, () => 0), now + Math.round(LIMITS_POLL_MS * 0.85));
  assert.equal(nextPollAt(null, now, () => 0.5), now + LIMITS_POLL_MS);
  assert.ok(nextPollAt(null, now, () => 0.999) <= now + LIMITS_POLL_MS * 1.15);
  assert.equal(nextPollAt(limitsAt(40, now + 2 * MINUTE, now), now, () => 0.5), now + LIMITS_POLL_MS);
  assert.equal(nextPollAt(limitsAt(100, now + 2 * MINUTE, now), now, () => 0), now + 2 * MINUTE + RESET_GRACE_MS);
  assert.equal(nextPollAt(limitsAt(100, now + 10_000, now), now, () => 0), now + MIN_POLL_GAP_MS);
  assert.equal(nextPollAt(limitsAt(100, now + 2 * HOUR, now), now, () => 0.5), now + LIMITS_POLL_MS);
  assert.equal(nextPollAt(limitsAt(100, now + 2 * MINUTE, now, "Opus"), now, () => 0.5), now + LIMITS_POLL_MS);
  assert.equal(nextPollAt(limitsAt(100, null, now), now, () => 0.5), now + LIMITS_POLL_MS);
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
  assert.equal(failureDelay({ code: "UPSTREAM_RATE_LIMITED", retryAfterMs: 30_000 }, 1, zero), LIMITS_POLL_MS);
  assert.equal(failureDelay({ code: "UPSTREAM_RATE_LIMITED", retryAfterMs: null }, 1, zero), 15 * MINUTE);
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
  nudgeLimits(target.id, now);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((snapshotRows.get(target.id)?.nextAt as Date).getTime(), now);
  snapshotRows.get(target.id)!.nextAt = new Date(now + 4 * MINUTE);
  nudgeLimits(target.id, now + 1_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((snapshotRows.get(target.id)?.nextAt as Date).getTime(), now + 4 * MINUTE);
  assert.equal(upstreamCalls.length, 0);
});
