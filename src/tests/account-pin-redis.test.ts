import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

process.env.REDIS_URL = "redis://redis.test:6379";

type Pin = { providerId: string; handoffAt: number };

const store = new Map<string, string>();
const settles: { key: string; expected: string; ttl: number }[] = [];
let down = false;

function unavailable(): void {
  if (down) throw new Error("redis offline");
}

const fakeRedis = {
  async get(key: string) {
    unavailable();
    return store.get(key) ?? null;
  },
  async eval(_script: string, _keys: number, key: string, wanted: string, expected: string, ttl: number) {
    unavailable();
    settles.push({ key, expected, ttl });
    const next = JSON.parse(wanted) as Pin;
    const raw = store.get(key);
    const stored = raw ? (JSON.parse(raw) as Pin) : null;
    if (stored && stored.providerId !== expected) {
      if (stored.providerId !== next.providerId) return raw;
      next.handoffAt = Math.max(stored.handoffAt, next.handoffAt);
    }
    const encoded = JSON.stringify(next);
    store.set(key, encoded);
    return encoded;
  },
};
(globalThis as { __llmhubRedis?: Promise<unknown> }).__llmhubRedis = Promise.resolve(fakeRedis);

const KEY = (session: string) => `llmhub:account-pin:v1:claude:${session}`;

beforeEach(async () => {
  const { forgetPins } = await import("@/lib/gateway/routing/account-affinity");
  forgetPins();
  store.clear();
  settles.length = 0;
  down = false;
});

test("a pin another replica moved wins over the local copy", async () => {
  const { readPin, writePin, PIN_TTL_MS } = await import("@/lib/gateway/routing/account-affinity");
  assert.deepEqual(await writePin("claude", "moved", { providerId: "acct-a", handoffAt: 0 }, null), {
    providerId: "acct-a",
    handoffAt: 0,
  });
  assert.deepEqual(settles, [{ key: KEY("moved"), expected: "", ttl: PIN_TTL_MS }]);
  store.set(KEY("moved"), JSON.stringify({ providerId: "acct-b", handoffAt: 7 }));
  assert.deepEqual(await readPin("claude", "moved"), { providerId: "acct-b", handoffAt: 7 });
});

test("a replica that lost the handover race adopts the winner instead of overwriting it", async () => {
  const { readPin, writePin } = await import("@/lib/gateway/routing/account-affinity");
  const pinned = { providerId: "acct-a", handoffAt: 0 };
  store.set(KEY("race"), JSON.stringify({ providerId: "acct-b", handoffAt: 4 }));
  assert.deepEqual(await writePin("claude", "race", { providerId: "acct-c", handoffAt: 4 }, pinned), {
    providerId: "acct-b",
    handoffAt: 4,
  });
  assert.equal(settles[0]!.expected, "acct-a");
  assert.equal(store.get(KEY("race")), JSON.stringify({ providerId: "acct-b", handoffAt: 4 }));
  down = true;
  assert.deepEqual(await readPin("claude", "race"), { providerId: "acct-b", handoffAt: 4 });
});

test("without Redis the replica keeps routing on its own pins", async () => {
  const { readPin, writePin } = await import("@/lib/gateway/routing/account-affinity");
  await writePin("claude", "offline", { providerId: "acct-a", handoffAt: 0 }, null);
  down = true;
  assert.deepEqual(await readPin("claude", "offline"), { providerId: "acct-a", handoffAt: 0 });
  assert.deepEqual(await writePin("claude", "offline", { providerId: "acct-b", handoffAt: 2 }, { providerId: "acct-a", handoffAt: 0 }), {
    providerId: "acct-b",
    handoffAt: 2,
  });
  assert.deepEqual(await readPin("claude", "offline"), { providerId: "acct-b", handoffAt: 2 });
  down = false;
  store.delete(KEY("offline"));
  assert.deepEqual(await readPin("claude", "offline"), { providerId: "acct-b", handoffAt: 2 });
});
