import assert from "node:assert/strict";
import test from "node:test";
import type { JsonMap, Principal } from "@/types/gateway";
import type { ResolvedDeployment, ResolvedModelGroup } from "@/types/routing";

type FakeProvider = { id: string; weight: number; limit: number | null; adaptive?: boolean };

delete process.env.REDIS_URL;

const groups = new Map<string, ReturnType<typeof groupRow>>();
let counter = 0;

function groupRow(alias: string, providers: FakeProvider[]) {
  return {
    alias,
    enabled: true,
    strategy: "priority",
    billingMode: "routed",
    priceInput: 0,
    priceOutput: 0,
    priceTimeZone: "UTC",
    priceWindows: [],
    overflowGroup: "",
    numRetries: 0,
    fallbackGroups: [],
    deployments: providers.map((provider) => ({
      id: `dep-${provider.id}`,
      kind: "openai",
      baseUrl: "https://upstream.test/v1",
      model: "gpt-test",
      weight: provider.weight,
      costInput: 0,
      costOutput: 0,
      providerId: provider.id,
      provider: {
        id: provider.id,
        kind: "openai",
        baseUrl: "https://upstream.test/v1",
        apiKey: "",
        zdr: false,
        retentionDays: null,
        region: "",
        noTraining: false,
        enabled: true,
        restricted: false,
        internal: false,
        maxConcurrency: provider.limit,
        adaptiveConcurrency: provider.adaptive ?? false,
        assignments: [],
        login: null,
      },
    })),
  };
}

(globalThis as { prisma?: unknown }).prisma = {
  modelGroup: { findUnique: async ({ where }: { where: { alias: string } }) => groups.get(where.alias) ?? null },
  providerConnection: { findMany: async () => [], findUnique: async () => null },
  deployment: { findMany: async () => [] },
  providerLogin: { findUnique: async () => null },
  accountRouting: { findMany: async () => [] },
  setting: { findUnique: async () => null },
  gatewayAuditLog: { create: async () => ({}) },
};

function fresh(limits: (number | null)[], adaptive = false): { alias: string; providers: string[] } {
  counter += 1;
  const alias = `concurrency-${counter}`;
  const providers = limits.map((limit, index) => ({
    id: `conc-${counter}-${index}`,
    weight: limits.length - index,
    limit,
    adaptive,
  }));
  groups.set(alias, groupRow(alias, providers));
  return { alias, providers: providers.map((provider) => provider.id) };
}

async function route<T>(
  alias: string,
  fn: (dep: ResolvedDeployment, group: ResolvedModelGroup) => Promise<T>,
  opts: { deferRelease?: boolean; signal?: AbortSignal } = {},
) {
  const { withDeployment } = await import("@/lib/gateway/dispatch/chat");
  return withDeployment([alias], {}, fn, opts);
}

async function active(provider: string): Promise<number> {
  const { concurrencySnapshot } = await import("@/lib/gateway/routing/concurrency");
  return concurrencySnapshot(`provider:${provider}`).active;
}

async function queued(provider: string): Promise<number> {
  const { concurrencySnapshot } = await import("@/lib/gateway/routing/concurrency");
  return concurrencySnapshot(`provider:${provider}`).queued;
}

function settle(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("the default limit follows the provider kind, and a stored value wins", async () => {
  const { concurrencyLimit, defaultConcurrency, DEFAULT_API_CONCURRENCY, DEFAULT_SIGN_IN_CONCURRENCY } = await import(
    "@/lib/gateway/upstreams/provider-kinds"
  );
  assert.equal(defaultConcurrency("openai"), 128);
  assert.equal(defaultConcurrency("claude"), 12);
  assert.equal(defaultConcurrency("antigravity"), DEFAULT_SIGN_IN_CONCURRENCY);
  assert.equal(defaultConcurrency("xai"), DEFAULT_API_CONCURRENCY);
  assert.equal(concurrencyLimit("openai", null), 128);
  assert.equal(concurrencyLimit("openai", 3), 3);
  assert.equal(concurrencyLimit("openai", 0), 0);
  assert.equal(concurrencyLimit("openai", 10_000_000), 10_000);
});

test("permits queue in order, release once, and free the gate when idle", async () => {
  const { takePermit, concurrencySnapshot } = await import("@/lib/gateway/routing/concurrency");
  const key = "unit:fifo";
  const first = await takePermit(key, 1);
  const order: string[] = [];
  const second = takePermit(key, 1, { waitMs: 1_000 }).then((release) => {
    order.push("second");
    return release;
  });
  const third = takePermit(key, 1, { waitMs: 1_000 }).then((release) => {
    order.push("third");
    return release;
  });
  await settle();
  assert.deepEqual(concurrencySnapshot(key), { active: 1, queued: 2 });
  first();
  first();
  const releaseSecond = await second;
  await settle();
  assert.deepEqual(order, ["second"]);
  assert.deepEqual(concurrencySnapshot(key), { active: 1, queued: 1 });
  releaseSecond();
  (await third)();
  assert.deepEqual(order, ["second", "third"]);
  assert.deepEqual(concurrencySnapshot(key), { active: 0, queued: 0 });
});

test("a waiter that times out or is aborted leaves the queue without a permit", async () => {
  const { takePermit, concurrencySnapshot, isConcurrencyLimited } = await import("@/lib/gateway/routing/concurrency");
  const { isClientClosed } = await import("@/lib/gateway/errors");
  const key = "unit:timeout";
  const held = await takePermit(key, 1);
  const timedOut = await takePermit(key, 1, { waitMs: 10 }).catch((err: unknown) => err);
  assert.ok(isConcurrencyLimited(timedOut));
  const controller = new AbortController();
  const aborted = takePermit(key, 1, { waitMs: 5_000, signal: controller.signal }).catch((err: unknown) => err);
  await settle(5);
  controller.abort();
  assert.ok(isClientClosed(await aborted));
  assert.deepEqual(concurrencySnapshot(key), { active: 1, queued: 0 });
  held();
  assert.deepEqual(concurrencySnapshot(key), { active: 0, queued: 0 });
});

test("a full queue is refused at once, and a limit of 0 never waits", async () => {
  const { takePermit, queueCapacity, isConcurrencyLimited, concurrencySnapshot } = await import(
    "@/lib/gateway/routing/concurrency"
  );
  const key = "unit:full";
  const held = await takePermit(key, 1);
  const waiting = Array.from({ length: queueCapacity(1) }, () =>
    takePermit(key, 1, { waitMs: 1_000 }).catch((err: unknown) => err),
  );
  const refused = await takePermit(key, 1, { waitMs: 1_000 }).catch((err: unknown) => err);
  assert.ok(isConcurrencyLimited(refused));
  held();
  for (const pending of waiting) {
    const release = await pending;
    assert.equal(typeof release, "function");
    (release as () => void)();
  }
  assert.deepEqual(concurrencySnapshot(key), { active: 0, queued: 0 });
  const free = await Promise.all(Array.from({ length: 50 }, () => takePermit("unit:unlimited", 0)));
  assert.equal(free.length, 50);
  assert.deepEqual(concurrencySnapshot("unit:unlimited"), { active: 0, queued: 0 });
});

test("permits come back after a success, an upstream failure, and a caller error", async () => {
  const { GateError } = await import("@/lib/gateway/errors");
  const { alias, providers } = fresh([1]);
  const ok = await route(alias, async () => "answer");
  assert.equal(ok.result, "answer");
  assert.equal(await active(providers[0]!), 0);
  const upstream = await route(alias, async () => {
    throw new GateError(502, "upstream_error", "boom");
  }).catch((err: unknown) => err);
  assert.ok(upstream instanceof GateError);
  assert.equal(await active(providers[0]!), 0);
  const { clearCooldowns } = await import("@/lib/gateway/routing/provider-health");
  await clearCooldowns([`dep-${providers[0]}`]);
  const caller = await route(alias, async () => {
    throw new GateError(400, "invalid_request", "bad");
  }).catch((err: unknown) => err);
  assert.equal((caller as InstanceType<typeof GateError>).status, 400);
  assert.equal(await active(providers[0]!), 0);
  const thrown = await route(alias, async () => {
    throw new TypeError("network down");
  }).catch((err: unknown) => err);
  assert.ok(thrown);
  assert.equal(await active(providers[0]!), 0);
});

test("a busy connection hands the request to one with room; the strategy order stays", async () => {
  const { alias, providers } = fresh([1, 1]);
  const first = await route(alias, async (dep) => dep.provider_id, { deferRelease: true });
  assert.equal(first.result, providers[0]);
  const second = await route(alias, async (dep) => dep.provider_id, { deferRelease: true });
  assert.equal(second.result, providers[1]);
  first.release();
  second.release();
  second.release();
  const third = await route(alias, async (dep) => dep.provider_id);
  assert.equal(third.result, providers[0]);
  assert.equal(await active(providers[0]!), 0);
  assert.equal(await active(providers[1]!), 0);
});

test("a request waits for the busy connection and runs once the holder releases", async () => {
  const { alias, providers } = fresh([1]);
  const held = await route(alias, async () => "first", { deferRelease: true });
  let ran = false;
  const waiting = route(alias, async () => {
    ran = true;
    return "second";
  });
  await settle();
  assert.equal(ran, false);
  assert.equal(await queued(providers[0]!), 1);
  held.release();
  assert.equal((await waiting).result, "second");
  assert.equal(await active(providers[0]!), 0);
});

test("a client that hangs up while queued is answered 499 and holds no permit", async () => {
  const { isClientClosed } = await import("@/lib/gateway/errors");
  const { alias, providers } = fresh([1]);
  const held = await route(alias, async () => "first", { deferRelease: true });
  const controller = new AbortController();
  let ran = false;
  const waiting = route(
    alias,
    async () => {
      ran = true;
      return "never";
    },
    { signal: controller.signal },
  ).catch((err: unknown) => err);
  await settle();
  controller.abort();
  assert.ok(isClientClosed(await waiting));
  assert.equal(ran, false);
  assert.equal(await queued(providers[0]!), 0);
  assert.equal(await active(providers[0]!), 1);
  held.release();
  assert.equal(await active(providers[0]!), 0);
});

function upstreamStream(events: string[], fail = false): Response {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < events.length) {
          controller.enqueue(encoder.encode(events[index]!));
          index += 1;
          return;
        }
        if (fail) controller.error(new Error("upstream reset"));
        else controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

test("a relayed stream frees its permit when it completes, breaks, or the client cancels", async () => {
  const { relaySse } = await import("@/lib/gateway/protocols/sse");
  const { alias, providers } = fresh([1]);
  const events = ['data: {"delta":"a"}\n\n', 'data: {"delta":"b"}\n\n'];
  const relayed = async (fail: boolean) => {
    const routed = await route(alias, async () => upstreamStream(events, fail), { deferRelease: true });
    assert.equal(await active(providers[0]!), 1);
    return relaySse(routed.result, { onEnd: () => routed.release() });
  };
  await (await relayed(false)).text();
  assert.equal(await active(providers[0]!), 0);
  await (await relayed(true)).text().catch(() => "");
  assert.equal(await active(providers[0]!), 0);
  const cancelled = await relayed(false);
  const reader = cancelled.body!.getReader();
  await reader.read();
  await reader.cancel();
  await settle();
  assert.equal(await active(providers[0]!), 0);
});

test("a chat stream that breaks mid-way frees its permit", async () => {
  const { relayChatStream } = await import("@/lib/gateway/dispatch/chat");
  const { alias, providers } = fresh([1]);
  const routed = await route(
    alias,
    async () => upstreamStream(['data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n'], true),
    { deferRelease: true },
  );
  const principal = { actor: "test", userId: "", key: null, models: [], routeLimits: {}, pool: "api" } as unknown as Principal;
  const res = relayChatStream({
    res: routed.result,
    dep: routed.dep,
    group: routed.group,
    release: routed.release,
    principal,
    model: alias,
    body: { model: alias, messages: [] } as JsonMap,
    outputGuard: null,
    started: Date.now(),
  });
  const text = await res.text();
  assert.match(text, /"error"/);
  assert.equal(await active(providers[0]!), 0);
});

test("adaptive mode halves the limit on 429 and climbs back on success", async () => {
  const {
    adaptiveLimits,
    nextDecreasedLimit,
    nextIncreasedLimit,
    recordConcurrencyLimited,
    recordConcurrencySuccess,
    ADAPTIVE_LIMIT_TTL_MS,
  } = await import("@/lib/gateway/routing/provider-health");
  assert.equal(nextDecreasedLimit(8), 4);
  assert.equal(nextDecreasedLimit(1), 1);
  assert.equal(nextIncreasedLimit(4), 4.25);
  const now = Date.now();
  assert.equal(recordConcurrencyLimited("unit:aimd", 8, now), 4);
  assert.equal(recordConcurrencyLimited("unit:aimd", 8, now), 2);
  assert.equal((await adaptiveLimits(["unit:aimd"], now)).get("unit:aimd"), 2);
  for (let i = 0; i < 3; i++) recordConcurrencySuccess("unit:aimd", 8, now);
  assert.equal((await adaptiveLimits(["unit:aimd"], now)).get("unit:aimd"), 3);
  for (let i = 0; i < 40; i++) recordConcurrencySuccess("unit:aimd", 8, now);
  assert.equal((await adaptiveLimits(["unit:aimd"], now)).has("unit:aimd"), false);
  recordConcurrencyLimited("unit:aimd-expiry", 8, now);
  assert.equal((await adaptiveLimits(["unit:aimd-expiry"], now + ADAPTIVE_LIMIT_TTL_MS + 1)).has("unit:aimd-expiry"), false);
  assert.equal(recordConcurrencyLimited("unit:aimd-off", 0, now), 0);
  assert.equal((await adaptiveLimits(["unit:aimd-off"], now)).has("unit:aimd-off"), false);
});

test("an upstream 429 lowers the adaptive limit that routing applies next", async () => {
  const { GateError } = await import("@/lib/gateway/errors");
  const { adaptiveLimits, clearCooldowns } = await import("@/lib/gateway/routing/provider-health");
  const adaptive = fresh([8], true);
  await route(adaptive.alias, async () => {
    throw new GateError(429, "rate_limit_exceeded", "slow down", { retryAt: Date.now() + 10 });
  }).catch(() => null);
  const key = `provider:${adaptive.providers[0]}`;
  assert.equal((await adaptiveLimits([key])).get(key), 4);
  assert.equal(await active(adaptive.providers[0]!), 0);
  const fixed = fresh([8], false);
  await route(fixed.alias, async () => {
    throw new GateError(429, "rate_limit_exceeded", "slow down", { retryAt: Date.now() + 10 });
  }).catch(() => null);
  const fixedKey = `provider:${fixed.providers[0]}`;
  assert.equal((await adaptiveLimits([fixedKey])).has(fixedKey), false);
  await clearCooldowns([`dep-${adaptive.providers[0]}`, `dep-${fixed.providers[0]}`]);
});

test("a saturated provider answers 429 with a short retry and fires no upstream alert", async () => {
  const { concurrencyLimitedError } = await import("@/lib/gateway/routing/concurrency");
  const { shouldAlert } = await import("@/lib/alerts/notify");
  const { retryHeaders } = await import("@/lib/gateway/access/gate");
  const now = Date.now();
  const err = concurrencyLimitedError(now);
  assert.equal(err.status, 429);
  assert.equal(err.code, "concurrency_limit_exceeded");
  assert.equal(err.type, "rate_limit_error");
  assert.equal(shouldAlert(err), false);
  assert.deepEqual(retryHeaders(err, now), { "retry-after": "1", "x-should-retry": "true" });
});
