import assert from "node:assert/strict";
import test from "node:test";

process.env.REDIS_URL = "redis://redis.test:6379";

const store = new Map<string, string>();
const fakeRedis = {
  async set(key: string, value: string) {
    store.set(key, value);
    return "OK";
  },
  async mget(keys: string[]) {
    return keys.map((key) => store.get(key) ?? null);
  },
  async del(...keys: string[]) {
    let removed = 0;
    for (const key of keys) if (store.delete(key)) removed += 1;
    return removed;
  },
  async hincrby() {
    return 1;
  },
  async expire() {
    return 1;
  },
};
(globalThis as { __llmhubRedis?: Promise<unknown> }).__llmhubRedis = Promise.resolve(fakeRedis);

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const HOUR = 3_600_000;

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("clearing a cooldown removes the shared park and leaves a marker for other replicas", async () => {
  const { clearCooldowns, coolingDown, recordFailure } = await import("@/lib/gateway/routing/provider-health");
  recordFailure("dep-a", NOW, NOW + HOUR);
  await settle();
  assert.ok(store.has("llmhub:health:v1:cooldown:dep-a"));
  assert.deepEqual([...(await coolingDown(["dep-a"], NOW + 1))], ["dep-a"]);
  await clearCooldowns(["dep-a"], NOW + 2);
  assert.equal(store.has("llmhub:health:v1:cooldown:dep-a"), false);
  assert.equal(store.get("llmhub:health:v1:cleared:dep-a"), String(NOW + 2));
  assert.equal((await coolingDown(["dep-a"], NOW + 3)).size, 0);
});

test("a replica drops its own parked deployment once another replica cleared it", async () => {
  const { coolingDown, recordFailure } = await import("@/lib/gateway/routing/provider-health");
  recordFailure("dep-b", NOW, NOW + HOUR);
  await settle();
  store.delete("llmhub:health:v1:cooldown:dep-b");
  store.set("llmhub:health:v1:cleared:dep-b", String(NOW + 10));
  assert.equal((await coolingDown(["dep-b"], NOW + 20)).size, 0);
  assert.equal((await coolingDown(["dep-b"], NOW + 30)).size, 0);
});

test("a failure recorded after the clear marker keeps the deployment parked", async () => {
  const { coolingDown, recordFailure } = await import("@/lib/gateway/routing/provider-health");
  store.set("llmhub:health:v1:cleared:dep-c", String(NOW));
  recordFailure("dep-c", NOW + 5, NOW + HOUR);
  await settle();
  store.delete("llmhub:health:v1:cooldown:dep-c");
  assert.deepEqual([...(await coolingDown(["dep-c"], NOW + 10))], ["dep-c"]);
});
