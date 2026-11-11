import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { antigravityQuotaBuckets } from "@/lib/gateway/upstreams/antigravity-quota";
import { limitGroups } from "@/lib/gateway/upstreams/limit-groups";
import {
  accountRecoveryAt,
  hasExhaustedQuota,
  isAccountBucket,
  modelRecoveryAt,
  quotaBottleneckReset,
  quotaExhausted,
  quotaPressure,
  windowKickoffDue,
} from "@/lib/gateway/routing/quota";
import { usageWindows } from "@/lib/providers/key-usage-shares";
import type { LimitWindow, SignInSession, SubscriptionLimits } from "@/types/providers";
import { holdAntigravityVersion } from "./support/antigravity-version";

type FakeLogin = {
  providerId: string;
  account: string;
  plan: string;
  tokens: string;
  expiresAt: Date;
  status: string;
  version: number;
  leaseUntil: Date | null;
  refreshedAt: Date | null;
  retryAt: Date | null;
  failures: number;
};

const logins = new Map<string, FakeLogin>();

(globalThis as { prisma?: unknown }).prisma = {
  providerLogin: {
    findUnique: async ({ where }: { where: { providerId: string } }) => {
      const row = logins.get(where.providerId);
      return row ? { ...row } : null;
    },
    updateMany: async () => ({ count: 0 }),
  },
};

const NOW = Date.parse("2026-10-20T12:00:00Z");
const HOUR = 3_600_000;
const iso = (hours: number) => new Date(NOW + hours * HOUR).toISOString();
const MODELS_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
const SUMMARY_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";

const SUMMARY = {
  groups: [
    {
      displayName: "Gemini Models",
      buckets: [
        { bucketId: "gemini-weekly", displayName: "Weekly Limit Remaining", window: "weekly", remainingFraction: 0.25, resetTime: iso(72) },
        { bucketId: "gemini-5h", displayName: "Five Hour Limit Remaining", window: "5h", remainingFraction: 0.9, resetTime: iso(3) },
      ],
    },
    {
      displayName: "Claude and GPT models",
      buckets: [
        { bucketId: "3p-weekly", displayName: "Weekly Limit Remaining", window: "weekly", remainingFraction: 0.8, resetTime: iso(72) },
        { bucketId: "3p-5h", displayName: "Five Hour Limit Remaining", window: "5h", remainingFraction: 1, resetTime: iso(3) },
      ],
    },
  ],
};

const MODELS = {
  models: {
    "claude-sonnet-4-6": { displayName: "Claude Sonnet 4.6", quotaInfo: { remainingFraction: 0.6, resetTime: iso(2) } },
    "gemini-3.1-pro-high": { displayName: "Gemini 3.1 Pro (High)" },
  },
};

const realFetch = globalThis.fetch;
let calls: { url: string; body: string; headers: Record<string, string> }[] = [];
let counter = 0;

function respondWith(handler: (url: string) => Response) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : "", headers: (init?.headers ?? {}) as Record<string, string> });
    return handler(url);
  }) as typeof fetch;
}

async function seedAccount(): Promise<string> {
  const { sealTokens } = await import("@/lib/gateway/upstreams/credentials");
  counter += 1;
  const providerId = `ag-quota-${counter}`;
  const tokens: SignInSession["tokens"] = { access: "tok", refresh: "r", accountId: "proj-1", residency: "" };
  logins.set(providerId, {
    providerId,
    account: "dev@example.com",
    plan: "pro",
    tokens: sealTokens(tokens),
    expiresAt: new Date(Date.now() + HOUR),
    status: "active",
    version: 0,
    leaseUntil: null,
    refreshedAt: null,
    retryAt: null,
    failures: 0,
  });
  return providerId;
}

async function readLimits(summary: (url: string) => Response, account?: string): Promise<SubscriptionLimits> {
  const { fetchSubscriptionLimits } = await import("@/lib/gateway/upstreams/subscription-limits");
  respondWith((url) => (url === MODELS_URL ? Response.json(MODELS) : summary(url)));
  const limits = await fetchSubscriptionLimits({ id: account ?? (await seedAccount()), kind: "antigravity", apiKey: "" });
  assert.ok(limits);
  return limits;
}

function limits(windows: LimitWindow[]): SubscriptionLimits {
  return { plan: "pro", windows, credits: null, resetCredits: null, extraUsage: null, fetchedAt: iso(0) };
}

function bucket(id: string, usedPercent: number, hours: number, windowSeconds: number, label = "Gemini Models"): LimitWindow {
  return {
    scope: id,
    exactScope: true,
    accountBucket: id,
    label,
    windowSeconds,
    usedPercent,
    resetsAt: iso(hours),
    limitReached: usedPercent >= 100,
  };
}

beforeEach(() => {
  calls = [];
  logins.clear();
  holdAntigravityVersion();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("the quota summary becomes one account-level window per bucket, shorter window first", () => {
  assert.deepEqual(antigravityQuotaBuckets(SUMMARY), [
    bucket("gemini-5h", 10, 3, 18_000),
    bucket("gemini-weekly", 75, 72, 604_800),
    bucket("3p-5h", 0, 3, 18_000, "Claude and GPT models"),
    bucket("3p-weekly", 20, 72, 604_800, "Claude and GPT models"),
  ]);
});

test("an exhausted bucket omits its fraction and still counts as used up", () => {
  const [window] = antigravityQuotaBuckets({
    groups: [{ displayName: "Gemini Models", buckets: [{ bucketId: "gemini-weekly", window: "weekly", resetTime: iso(48) }] }],
  });
  assert.deepEqual(window, bucket("gemini-weekly", 100, 48, 604_800));
});

test("disabled, unknown, unnamed, and unreadable buckets are left out", () => {
  const windows = antigravityQuotaBuckets({
    groups: [
      {
        displayName: "Gemini Models",
        buckets: [
          { bucketId: "gemini-5h", window: "5h", remainingFraction: 1, disabled: true },
          { bucketId: "gemini-weekly", window: "weekly" },
          { bucketId: "gemini-daily", window: "daily", remainingFraction: 0.5, resetTime: iso(5) },
          { window: "weekly", remainingFraction: 0.5, resetTime: iso(5) },
          { bucketId: "x".repeat(65), window: "5h", remainingFraction: 0.5 },
          null,
          7,
        ],
      },
      {
        displayName: "Gemini 4 Argon",
        buckets: [
          { bucketId: "gemini-argon-wtu-weekly", remainingFraction: 0.5, resetTime: iso(24) },
          { bucketId: "gemini-argon-wtu-weekly", remainingFraction: 0.1, resetTime: iso(24) },
        ],
      },
    ],
  });
  assert.deepEqual(windows, [bucket("gemini-argon-wtu-weekly", 50, 24, 604_800, "Gemini 4 Argon")]);
});

test("answers of another shape yield no account-level windows", () => {
  const shapes: unknown[] = [
    null,
    undefined,
    "groups",
    42,
    [],
    [SUMMARY],
    {},
    { groups: [] },
    { groups: "none" },
    { groups: [null, 1, "x", {}, { buckets: "none" }, { buckets: [null, 3, "x", []] }] },
    { models: { "gemini-5h": { quotaInfo: { remainingFraction: 0 } } } },
  ];
  for (const shape of shapes) assert.deepEqual(antigravityQuotaBuckets(shape), [], JSON.stringify(shape));
});

test("an oversized summary is cut to a bounded number of windows", () => {
  const groups = Array.from({ length: 200 }, (_, group) => ({
    displayName: `Group ${group}`,
    buckets: Array.from({ length: 200 }, (_, index) => ({
      bucketId: `g${group}-b${index}-5h`,
      remainingFraction: 0.5,
      resetTime: iso(1),
    })),
  }));
  assert.equal(antigravityQuotaBuckets({ groups }).length, 32);
});

test("a limits read adds the account-level windows to the per-model ones", async () => {
  const read = await readLimits(() => Response.json(SUMMARY));
  assert.deepEqual(
    calls.map((call) => call.url),
    [MODELS_URL, SUMMARY_URL],
  );
  assert.deepEqual(JSON.parse(calls[1]!.body), { project: "proj-1" });
  assert.equal(calls[1]!.headers.Authorization, "Bearer tok");
  assert.equal(calls[1]!.headers["User-Agent"], calls[0]!.headers["User-Agent"]);
  assert.deepEqual(
    read.windows.map((window) => [window.scope, window.accountBucket ?? null, window.usedPercent]),
    [
      ["claude-sonnet-4-6", null, 40],
      ["gemini-5h", "gemini-5h", 10],
      ["gemini-weekly", "gemini-weekly", 75],
      ["3p-5h", "3p-5h", 0],
      ["3p-weekly", "3p-weekly", 20],
    ],
  );
});

const FAILED_SUMMARIES: { name: string; reply: () => Response }[] = [
  { name: "a refusal for free accounts", reply: () => Response.json({ error: { code: 403, message: "denied" } }, { status: 403 }) },
  { name: "a missing endpoint", reply: () => new Response("not found", { status: 404 }) },
  { name: "a rate limit", reply: () => Response.json({ error: { code: 429 } }, { status: 429, headers: { "retry-after": "600" } }) },
  { name: "a server error", reply: () => new Response("", { status: 500 }) },
  { name: "a body that is not JSON", reply: () => new Response("<html>ok</html>", { status: 200 }) },
  { name: "a JSON array", reply: () => Response.json([SUMMARY]) },
  {
    name: "a network failure",
    reply: () => {
      throw new Error("down");
    },
  },
];

for (const failed of FAILED_SUMMARIES) {
  test(`a limits read keeps the per-model windows after ${failed.name} on the summary`, async () => {
    const read = await readLimits(failed.reply);
    assert.equal(calls.length, 2);
    assert.deepEqual(
      read.windows.map((window) => [window.scope, window.exactScope, window.usedPercent, isAccountBucket(window)]),
      [["claude-sonnet-4-6", true, 40, false]],
    );
  });
}

for (const status of [403, 404]) {
  test(`a summary refused with ${status} is not asked again on the next reads of that account`, async () => {
    const account = await seedAccount();
    await readLimits(() => new Response("", { status }), account);
    await readLimits(() => Response.json(SUMMARY), account);
    assert.deepEqual(
      calls.map((call) => call.url),
      [MODELS_URL, SUMMARY_URL, MODELS_URL],
    );
    const other = await readLimits(() => Response.json(SUMMARY));
    assert.equal(other.windows.filter(isAccountBucket).length, 4);
  });
}

test("a summary that failed for another reason is asked again, and a forgotten account too", async () => {
  const { forgetLimits } = await import("@/lib/gateway/upstreams/subscription-limits");
  const account = await seedAccount();
  await readLimits(() => new Response("", { status: 500 }), account);
  const retried = await readLimits(() => Response.json(SUMMARY), account);
  assert.equal(retried.windows.filter(isAccountBucket).length, 4);
  await readLimits(() => new Response("", { status: 403 }), account);
  await forgetLimits(account);
  const renewed = await readLimits(() => Response.json(SUMMARY), account);
  assert.equal(renewed.windows.filter(isAccountBucket).length, 4);
});

test("account-level windows never change what routing decides for a model", () => {
  const perModel: LimitWindow[] = [
    { scope: "claude-sonnet-4-6", exactScope: true, usedPercent: 40, windowSeconds: 0, resetsAt: iso(2), limitReached: false },
    { scope: "", usedPercent: 30, windowSeconds: 18_000, resetsAt: iso(-1), limitReached: false },
  ];
  const buckets = [
    bucket("gemini-weekly", 100, 72, 604_800),
    bucket("gemini-5h", 100, 3, 18_000),
    bucket("3p-5h", 100, 3, 18_000, "Claude and GPT models"),
    bucket("3p-weekly", 60, -2, 604_800, "Claude and GPT models"),
  ];
  const without = limits(perModel);
  const withBuckets = limits([...perModel, ...buckets]);
  const models = ["gemini-3.1-pro-high", "gemini-2.5-flash", "claude-sonnet-4-6", "gpt-oss-120b", "gemini-weekly", "gemini-5h", "3p-5h", ""];
  for (const model of models) {
    assert.equal(quotaExhausted(withBuckets, model, NOW), quotaExhausted(without, model, NOW), `exhausted ${model}`);
    assert.equal(quotaPressure(withBuckets, model, NOW), quotaPressure(without, model, NOW), `pressure ${model}`);
    assert.equal(quotaBottleneckReset(withBuckets, model, NOW), quotaBottleneckReset(without, model, NOW), `bottleneck ${model}`);
    assert.equal(modelRecoveryAt(withBuckets, model, NOW), modelRecoveryAt(without, model, NOW), `recovery ${model}`);
    assert.equal(windowKickoffDue(withBuckets, model, null, NOW), windowKickoffDue(without, model, null, NOW), `kickoff ${model}`);
  }
  assert.equal(quotaExhausted(withBuckets, "gemini-3.1-pro-high", NOW), false);
  assert.equal(quotaExhausted(withBuckets, "claude-sonnet-4-6", NOW), false);
});

test("an exhausted account-level window neither holds cooldowns nor moves the next poll", () => {
  const roomy: LimitWindow[] = [
    { scope: "claude-sonnet-4-6", exactScope: true, usedPercent: 40, windowSeconds: 0, resetsAt: iso(2), limitReached: false },
  ];
  const full: LimitWindow[] = [
    { scope: "claude-sonnet-4-6", exactScope: true, usedPercent: 100, windowSeconds: 0, resetsAt: iso(6), limitReached: true },
  ];
  const buckets = [bucket("gemini-weekly", 100, 72, 604_800), bucket("gemini-5h", 100, 3, 18_000)];
  assert.equal(hasExhaustedQuota(limits([...roomy, ...buckets]), NOW), false);
  assert.equal(accountRecoveryAt(limits([...roomy, ...buckets]), NOW), null);
  assert.equal(hasExhaustedQuota(limits(buckets), NOW), false);
  assert.equal(hasExhaustedQuota(limits([...full, ...buckets]), NOW), true);
  assert.equal(accountRecoveryAt(limits([...full, ...buckets]), NOW), NOW + 6 * HOUR);
});

test("each bucket is its own meter ahead of the model families", () => {
  const perModel: LimitWindow[] = [
    { scope: "claude-sonnet-4-6", exactScope: true, label: "Claude Sonnet 4.6", usedPercent: 40, windowSeconds: 0, resetsAt: iso(2), limitReached: false },
    { scope: "gemini-3.1-pro-high", exactScope: true, label: "Gemini 3.1 Pro (High)", usedPercent: 0, windowSeconds: 0, resetsAt: null, limitReached: false },
  ];
  const without = limitGroups("antigravity", limits(perModel), NOW);
  const groups = limitGroups("antigravity", limits([...perModel, ...antigravityQuotaBuckets(SUMMARY)]), NOW);
  assert.deepEqual(
    groups.slice(0, 4).map((group) => [group.id, group.label, group.windowSeconds, group.usedPercent, group.scoped, group.family]),
    [
      ["bucket:gemini-5h", "Gemini Models", 18_000, 10, true, null],
      ["bucket:gemini-weekly", "Gemini Models", 604_800, 75, true, null],
      ["bucket:3p-5h", "Claude and GPT models", 18_000, 0, true, null],
      ["bucket:3p-weekly", "Claude and GPT models", 604_800, 20, true, null],
    ],
  );
  assert.deepEqual(groups.slice(4), without);
  assert.deepEqual(
    without.map((group) => group.id),
    ["family:gemini_pro", "family:claude"],
  );
});

test("account-level meters carry no per-key attribution", () => {
  const windows = [
    { scope: "claude-sonnet-4-6", exactScope: true, usedPercent: 40, windowSeconds: 18_000, resetsAt: iso(2), limitReached: false },
    ...antigravityQuotaBuckets(SUMMARY),
  ];
  assert.deepEqual(
    usageWindows("antigravity", limits(windows), NOW).map((window) => window.groupId),
    ["family:claude"],
  );
});

test("the marker survives the snapshot store and older snapshots read without it", async () => {
  const { limitsOf } = await import("@/lib/gateway/upstreams/limit-store");
  const stored = limitsOf(JSON.parse(JSON.stringify(limits(antigravityQuotaBuckets(SUMMARY)))));
  assert.deepEqual(
    stored?.windows.map((window) => window.accountBucket),
    ["gemini-5h", "gemini-weekly", "3p-5h", "3p-weekly"],
  );
  const older = limitsOf({ plan: "pro", windows: [{ scope: "gemini-2.5-flash", usedPercent: 100, windowSeconds: 0, resetsAt: iso(1), limitReached: true }], fetchedAt: iso(0) });
  assert.equal(older?.windows.some(isAccountBucket), false);
  assert.equal(quotaExhausted(older ?? null, "gemini-2.5-flash", NOW), true);
});
