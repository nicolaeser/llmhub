import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { latestRequests } from "@/lib/gateway/request-logs/requests-feed";
import { loginData } from "@/lib/gateway/upstreams/credentials";
import { LIMITS_POLL_MS, readLimitSnapshots, refreshLimits } from "@/lib/gateway/upstreams/limit-store";
import { loadProviderLimits, loadSubscriptionLimits } from "@/lib/providers/connections";
import { LIMITS_FEED } from "@/lib/providers/limits-feed";
import { usageToday } from "@/lib/usage/usage-today";
import type { LimitPollAccount } from "@/types/providers";
import { closeDatabase, ownerSession, uniqueName } from "./support/database";

after(closeDatabase);

const realFetch = globalThis.fetch;
let usageCalls = 0;

afterEach(() => {
  globalThis.fetch = realFetch;
  usageCalls = 0;
});

function usageReply(used: number, delayMs = 0) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (!String(input).endsWith("/wham/usage")) throw new Error(`unexpected ${String(input)}`);
    usageCalls += 1;
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return Response.json({
      plan_type: "pro",
      rate_limit: { primary_window: { used_percent: used, limit_window_seconds: 18_000, reset_after_seconds: 3_600 } },
    });
  }) as typeof fetch;
}

function replyWith(response: () => Response) {
  globalThis.fetch = (async () => {
    usageCalls += 1;
    return response();
  }) as typeof fetch;
}

function forbidUpstream() {
  globalThis.fetch = (async (input: string | URL | Request) => {
    usageCalls += 1;
    throw new Error(`snapshot reads must not call ${String(input)}`);
  }) as typeof fetch;
}

async function codexAccount(): Promise<LimitPollAccount> {
  const account = `${uniqueName("codex")}@example.test`;
  const row = await prisma.providerConnection.create({
    data: {
      name: uniqueName("codex"),
      kind: "codex",
      login: {
        create: loginData({
          tokens: { access: `access-${account}`, refresh: `refresh-${account}`, accountId: "acct_1", residency: "" },
          expiresAt: Date.now() + 3_600_000,
          account,
          plan: "pro",
        }),
      },
    },
    include: { login: true },
  });
  return { id: row.id, kind: row.kind, apiKey: row.apiKey, enabled: true, loginVersion: row.login?.version ?? 0 };
}

test("two replicas refreshing one account at the same time reach the provider once", async () => {
  const account = await codexAccount();
  try {
    usageReply(37, 300);
    const now = Date.now();
    const results = await Promise.all([
      refreshLimits(account, { kind: "scheduled" }, { now }),
      refreshLimits(account, { kind: "scheduled" }, { now }),
      refreshLimits(account, { kind: "scheduled" }, { now }),
      refreshLimits(account, { kind: "manual" }, { now }),
      refreshLimits(account, { kind: "fresh", maxAgeMs: 60_000 }, { now }),
    ]);
    assert.equal(usageCalls, 1);
    assert.equal(results.filter((result) => result.status === "fetched").length, 1);
    const row = await prisma.providerLimitSnapshot.findUniqueOrThrow({ where: { providerId: account.id } });
    assert.equal(row.version, 1);
    assert.equal(row.leaseUntil, null);
    assert.equal(row.leaseToken, "");
    assert.equal(row.error, "");
    assert.ok(Math.abs(row.nextAt.getTime() - (now + LIMITS_POLL_MS)) <= 60_000);
    for (const result of results.filter((item) => item.status === "busy" && item.snapshot?.version === 1)) {
      assert.equal(result.limits?.windows[0]?.usedPercent, 37);
    }
    assert.equal((await refreshLimits(account, { kind: "scheduled" }, { now: now + 60_000 })).status, "skipped");
    assert.equal(usageCalls, 1);
  } finally {
    await prisma.providerConnection.deleteMany({ where: { id: account.id } });
  }
});

test("a rate-limited usage check stores Retry-After and blocks manual refreshes until it passes", async () => {
  const account = await codexAccount();
  const owner = await ownerSession();
  try {
    replyWith(() => new Response("", { status: 429, headers: { "retry-after": "900" } }));
    const now = Date.now();
    const limited = await refreshLimits(account, { kind: "scheduled" }, { now });
    assert.equal(limited.failure?.code, "UPSTREAM_RATE_LIMITED");
    const row = await prisma.providerLimitSnapshot.findUniqueOrThrow({ where: { providerId: account.id } });
    assert.equal(row.error, "UPSTREAM_RATE_LIMITED");
    assert.equal(row.failures, 1);
    assert.equal(row.retryAt?.getTime(), now + 900_000);
    assert.ok(row.nextAt.getTime() >= now + 900_000);
    await assert.rejects(
      runAsPrincipal(owner, () => loadProviderLimits({ id: account.id, refresh: true })),
      { message: "UPSTREAM_RATE_LIMITED" },
    );
    assert.equal(usageCalls, 1);
    const [item] = await readLimitSnapshots([account.id]);
    assert.equal(item?.error, "UPSTREAM_RATE_LIMITED");
    assert.equal(item?.retryAt, new Date(now + 900_000).toISOString());
  } finally {
    await prisma.providerConnection.deleteMany({ where: { id: account.id } });
    await prisma.user.deleteMany({ where: { id: owner.user.id } });
  }
});

test("console limit reads come from snapshots and a manual refresh respects the one-minute gap", async () => {
  const account = await codexAccount();
  const owner = await ownerSession();
  try {
    usageReply(64);
    await refreshLimits(account, { kind: "scheduled" });
    assert.equal(usageCalls, 1);
    forbidUpstream();
    const listed = await runAsPrincipal(owner, () => loadSubscriptionLimits());
    const mine = listed.items.find((item) => item.id === account.id);
    assert.equal(mine?.limits?.windows[0]?.usedPercent, 64);
    assert.equal(mine?.version, 1);
    assert.ok(listed.at <= Date.now());
    assert.equal(usageCalls, 1);
    const paths: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path.endsWith("/rate-limit-reset-credits")) {
        return Response.json({ credits: [], available_count: 0, total_earned_count: 0 });
      }
      throw new Error(`unexpected ${path}`);
    }) as typeof fetch;
    const single = await runAsPrincipal(owner, () => loadProviderLimits({ id: account.id, refresh: true }));
    assert.equal(single.limits?.windows[0]?.usedPercent, 64);
    assert.ok((single.item?.version ?? 0) >= 1);
    assert.equal(paths.filter((path) => path.endsWith("/wham/usage")).length, 0);
    assert.ok(paths.length <= 1);
    await runAsPrincipal(owner, () => loadProviderLimits({ id: account.id, refresh: true }));
    assert.ok(paths.length <= 1);
  } finally {
    await prisma.providerConnection.deleteMany({ where: { id: account.id } });
    await prisma.user.deleteMany({ where: { id: owner.user.id } });
  }
});

test("a snapshot written by another replica reaches the limits feed through its version", async () => {
  const account = await codexAccount();
  try {
    usageReply(12);
    await refreshLimits(account, { kind: "scheduled" });
    const first = await LIMITS_FEED.load({}, null);
    assert.equal(first.items.get(account.id)?.version, 1);
    assert.equal((await LIMITS_FEED.load({}, first)).items.get(account.id), first.items.get(account.id));
    const row = await prisma.providerLimitSnapshot.findUniqueOrThrow({ where: { providerId: account.id } });
    const limits = JSON.parse(JSON.stringify(row.limits)) as { windows: { usedPercent: number }[] };
    limits.windows[0]!.usedPercent = 99;
    await prisma.providerLimitSnapshot.update({
      where: { providerId: account.id },
      data: { limits, version: { increment: 1 } },
    });
    const next = await LIMITS_FEED.load({}, first);
    const delta = LIMITS_FEED.change(first, next) as { items: { id: string; version: number }[]; removed: string[] };
    assert.deepEqual(
      delta.items.filter((item) => item.id === account.id).map((item) => item.version),
      [2],
    );
    assert.equal(next.items.get(account.id)?.limits?.windows[0]?.usedPercent, 99);
    await prisma.providerLogin.update({ where: { providerId: account.id }, data: { status: "expired" } });
    const expired = await LIMITS_FEED.load({}, next);
    const gone = LIMITS_FEED.change(next, expired) as { removed: string[] };
    assert.ok(gone.removed.includes(account.id));
  } finally {
    await prisma.providerConnection.deleteMany({ where: { id: account.id } });
  }
});

test("the requests and usage feeds only count what the viewer's company scope may see", async () => {
  const mine = uniqueName("org");
  const other = uniqueName("org");
  const day = new Date(new Date().toISOString().slice(0, 10));
  const rows = await Promise.all([
    prisma.requestLog.create({ data: { orgId: mine, model: "m" } }),
    prisma.requestLog.create({ data: { orgId: other, model: "m" } }),
  ]);
  await prisma.usageDaily.createMany({
    data: [
      { day, orgId: mine, model: uniqueName("m"), requests: 3, errors: 1, cost: 1.25, promptTokens: 100, completionTokens: 20 },
      { day, orgId: other, model: uniqueName("m"), requests: 50, errors: 9, cost: 99, promptTokens: 1, completionTokens: 1 },
    ],
  });
  try {
    const latest = await latestRequests({ orgId: mine });
    assert.equal(latest.requestId, rows[0]!.id);
    assert.equal(latest.auditId, null);
    const today = await usageToday({ orgId: mine });
    assert.deepEqual(
      { requests: today.requests, errors: today.errors, spend: today.spend, tokens: today.tokens },
      { requests: 3, errors: 1, spend: 1.25, tokens: 120 },
    );
    assert.equal(today.day, day.toISOString().slice(0, 10));
  } finally {
    await prisma.requestLog.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
    await prisma.usageDaily.deleteMany({ where: { orgId: { in: [mine, other] } } });
  }
});
