import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import type { AccountAccess } from "@/types/providers";
import type { ResolvedDeployment } from "@/types/routing";

type FakeAccount = { id: string; kind: string; limit: number | null };

delete process.env.REDIS_URL;

const groups = new Map<string, ReturnType<typeof groupRow>>();
const routing = { keyConcurrency: 0, queries: 0 };
let counter = 0;

function groupRow(alias: string, accounts: FakeAccount[]) {
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
    deployments: accounts.map((account, index) => ({
      id: `dep-${account.id}`,
      kind: account.kind,
      baseUrl: "",
      model: "claude-test",
      weight: accounts.length - index,
      costInput: 0,
      costOutput: 0,
      providerId: account.id,
      provider: {
        id: account.id,
        kind: account.kind,
        baseUrl: "",
        apiKey: "",
        zdr: false,
        retentionDays: null,
        region: "",
        noTraining: false,
        enabled: true,
        restricted: false,
        internal: false,
        maxConcurrency: account.limit,
        adaptiveConcurrency: false,
        assignments: [],
        login: { status: "active" },
      },
    })),
  };
}

(globalThis as { prisma?: unknown }).prisma = {
  modelGroup: { findUnique: async ({ where }: { where: { alias: string } }) => groups.get(where.alias) ?? null },
  providerConnection: { findMany: async () => [], findUnique: async () => null },
  providerLimitSnapshot: { findMany: async () => [] },
  deployment: { findMany: async () => [] },
  providerLogin: { findUnique: async () => null },
  accountRouting: {
    findMany: async () => {
      routing.queries += 1;
      return routing.keyConcurrency > 0
        ? [{ kind: "claude", strategy: "smart", keyConcurrency: routing.keyConcurrency }]
        : [];
    },
  },
  setting: { findUnique: async () => null },
  gatewayAuditLog: { create: async () => ({}) },
};

function access(keyId: string): AccountAccess {
  return { orgId: "org", teamId: "", projectId: "", memberId: "", keyId, accountIds: [] };
}

function fresh(accounts: Omit<FakeAccount, "id">[]): { alias: string; ids: string[] } {
  counter += 1;
  const alias = `key-concurrency-${counter}`;
  const rows = accounts.map((account, index) => ({ ...account, id: `kc-${counter}-${index}` }));
  groups.set(alias, groupRow(alias, rows));
  return { alias, ids: rows.map((row) => row.id) };
}

async function acquire(alias: string, keyId: string, signal?: AbortSignal) {
  const { acquireGroup, loadGroup } = await import("@/lib/gateway/routing/runtime");
  const run = { session: "", tried: new Set<string>(), signal };
  return acquireGroup(await loadGroup(alias), undefined, () => true, "", undefined, access(keyId), run);
}

async function gate(key: string) {
  const { concurrencySnapshot } = await import("@/lib/gateway/routing/concurrency");
  return concurrencySnapshot(key);
}

function settle(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(async () => {
  const { forgetAccountPolicies } = await import("@/lib/gateway/routing/account-routing");
  const { forgetPins } = await import("@/lib/gateway/routing/account-affinity");
  const { resetConcurrencyGates } = await import("@/lib/gateway/routing/concurrency");
  routing.keyConcurrency = 0;
  routing.queries = 0;
  forgetAccountPolicies();
  forgetPins();
  resetConcurrencyGates();
});

test("the key target applies only to sign-in accounts of a kind with a limit and a key", async () => {
  const { keyConcurrencyTarget } = await import("@/lib/gateway/routing/runtime");
  const dep = (kind: string) => ({ id: "dep", kind, provider: { id: "acct", kind } }) as unknown as ResolvedDeployment;
  const limits = new Map([["claude", 3]]);
  assert.deepEqual(keyConcurrencyTarget(dep("claude"), access("key-a"), limits), {
    key: "key:claude:key-a",
    limit: 3,
    adaptive: false,
  });
  assert.equal(keyConcurrencyTarget(dep("codex"), access("key-a"), limits), null);
  assert.equal(keyConcurrencyTarget(dep("anthropic"), access("key-a"), new Map([["anthropic", 3]])), null);
  assert.equal(keyConcurrencyTarget(dep("claude"), access(""), limits), null);
  assert.equal(keyConcurrencyTarget(dep("claude"), null, limits), null);
  assert.equal(keyConcurrencyTarget(dep("claude"), access("key-a"), new Map()), null);
});

test("a key at its limit waits in line while other keys keep using the accounts", async () => {
  routing.keyConcurrency = 1;
  const { alias, ids } = fresh([{ kind: "claude", limit: null }]);
  const first = await acquire(alias, "key-a");
  let secondGranted = false;
  const second = acquire(alias, "key-a").then((acquired) => {
    secondGranted = true;
    return acquired;
  });
  await settle();
  assert.equal(secondGranted, false);
  assert.deepEqual(await gate("key:claude:key-a"), { active: 1, queued: 1 });
  assert.equal((await gate(`provider:${ids[0]}`)).active, 1);

  const other = await acquire(alias, "key-b");
  assert.equal((await gate(`provider:${ids[0]}`)).active, 2);
  other.release();

  first.release();
  const granted = await second;
  assert.equal(secondGranted, true);
  assert.deepEqual(await gate("key:claude:key-a"), { active: 1, queued: 0 });
  granted.release();
  granted.release();
  assert.deepEqual(await gate("key:claude:key-a"), { active: 0, queued: 0 });
  assert.equal((await gate(`provider:${ids[0]}`)).active, 0);
});

test("without a limit the key gate stays unused", async () => {
  const { alias } = fresh([{ kind: "claude", limit: null }]);
  const held = await Promise.all([acquire(alias, "key-a"), acquire(alias, "key-a"), acquire(alias, "key-a")]);
  assert.deepEqual(await gate("key:claude:key-a"), { active: 0, queued: 0 });
  for (const acquired of held) acquired.release();
});

test("a caller that gives up while waiting for its key leaves no permit behind", async () => {
  routing.keyConcurrency = 1;
  const { alias, ids } = fresh([{ kind: "claude", limit: null }]);
  const first = await acquire(alias, "key-a");
  const abort = new AbortController();
  const waiting = acquire(alias, "key-a", abort.signal);
  await settle();
  abort.abort();
  await assert.rejects(waiting, (err: Error & { code?: string }) => err.code === "client_closed_request");
  assert.deepEqual(await gate("key:claude:key-a"), { active: 1, queued: 0 });
  assert.equal((await gate(`provider:${ids[0]}`)).active, 1);
  first.release();
  assert.deepEqual(await gate("key:claude:key-a"), { active: 0, queued: 0 });
});

test("a key permit is returned when the account permit is not granted", async () => {
  routing.keyConcurrency = 2;
  const { alias, ids } = fresh([{ kind: "claude", limit: 1 }]);
  const first = await acquire(alias, "key-a");
  const abort = new AbortController();
  const waiting = acquire(alias, "key-a", abort.signal);
  await settle();
  assert.deepEqual(await gate("key:claude:key-a"), { active: 2, queued: 0 });
  assert.deepEqual(await gate(`provider:${ids[0]}`), { active: 1, queued: 1 });
  abort.abort();
  await assert.rejects(waiting);
  assert.deepEqual(await gate("key:claude:key-a"), { active: 1, queued: 0 });
  first.release();
  assert.deepEqual(await gate("key:claude:key-a"), { active: 0, queued: 0 });
  assert.deepEqual(await gate(`provider:${ids[0]}`), { active: 0, queued: 0 });
});

test("a key over its limit prefers a kind where it still has room", async () => {
  routing.keyConcurrency = 1;
  const { alias, ids } = fresh([
    { kind: "claude", limit: null },
    { kind: "codex", limit: null },
  ]);
  const first = await acquire(alias, "key-a");
  assert.equal(first.dep.provider?.id, ids[0]);
  const second = await acquire(alias, "key-a");
  assert.equal(second.dep.provider?.id, ids[1]);
  first.release();
  second.release();
});

test("a full key queue answers with a key-specific concurrency error", async () => {
  const { takePermit, keyConcurrencyLimitedError, queueCapacity } = await import("@/lib/gateway/routing/concurrency");
  const key = "key:claude:unit";
  const held = await takePermit(key, 1);
  const waiters = Array.from({ length: queueCapacity(1) }, () =>
    takePermit(key, 1, { waitMs: 1_000, limited: () => keyConcurrencyLimitedError("claude") }),
  );
  await assert.rejects(
    takePermit(key, 1, { waitMs: 1_000, limited: () => keyConcurrencyLimitedError("claude") }),
    (err: Error & { code?: string; status?: number }) =>
      err.code === "concurrency_limit_exceeded" && err.status === 429 && err.message.includes("API key on claude"),
  );
  held();
  for (const waiter of waiters) (await waiter)();
  assert.deepEqual(await gate(key), { active: 0, queued: 0 });
});

test("acquireGroup skips accountRouting queries without a key or without sign-in routes", async () => {
  const { acquireGroup, loadGroup } = await import("@/lib/gateway/routing/runtime");
  const { writePin } = await import("@/lib/gateway/routing/account-affinity");

  const api = fresh([{ kind: "openai", limit: null }]);
  const apiGroup = await loadGroup(api.alias);
  const apiWithKey = await acquireGroup(apiGroup, undefined, () => true, "", undefined, access("key-a"), null);
  apiWithKey.release();
  const apiWithoutAccess = await acquireGroup(apiGroup, undefined, () => true, "", undefined, null, null);
  apiWithoutAccess.release();
  assert.equal(routing.queries, 0);

  const signIn = fresh([{ kind: "claude", limit: null }]);
  const signInGroup = await loadGroup(signIn.alias);
  await writePin("claude", "session-1", { providerId: signIn.ids[0]!, handoffAt: 0 }, null);
  const run = { session: "session-1", tried: new Set<string>() };

  const withoutAccess = await acquireGroup(signInGroup, undefined, () => true, "", undefined, null, run);
  withoutAccess.release();
  const withoutKeyId = await acquireGroup(signInGroup, undefined, () => true, "", undefined, access(""), run);
  withoutKeyId.release();
  assert.equal(routing.queries, 0);

  const withKey = await acquireGroup(signInGroup, undefined, () => true, "", undefined, access("key-a"), run);
  withKey.release();
  assert.equal(routing.queries, 1);
});
