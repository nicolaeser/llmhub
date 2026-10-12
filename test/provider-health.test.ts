import assert from "node:assert/strict";
import test from "node:test";
import {
  COOLDOWN_MS,
  coolingDown,
  deploymentHealth,
  foldHealth,
  HEALTH_RETENTION_MINUTES,
  LATENCY_BOUNDS_MS,
  latencyBucket,
  latencyPercentile,
  MAX_LIMIT_COOLDOWN_MS,
  recordFailure,
  recordSuccess,
  resetProviderHealthMemory,
  summarizeHealth,
} from "@/lib/gateway/provider-health";

const NOW = Date.UTC(2026, 9, 9, 12, 0, 30);

function histogram(entries: Record<number, number>): number[] {
  const out = new Array(LATENCY_BOUNDS_MS.length + 1).fill(0);
  for (const [index, n] of Object.entries(entries)) out[Number(index)] = n;
  return out;
}

test("latency buckets use inclusive upper bounds and an overflow bucket", () => {
  assert.equal(latencyBucket(0), 0);
  assert.equal(latencyBucket(50), 0);
  assert.equal(latencyBucket(51), 1);
  assert.equal(latencyBucket(1_000), LATENCY_BOUNDS_MS.indexOf(1_000));
  assert.equal(latencyBucket(10_000_000), LATENCY_BOUNDS_MS.length);
});

test("latency percentiles interpolate inside the bucket that holds the rank", () => {
  assert.equal(latencyPercentile(histogram({}), 50), null);
  const index = LATENCY_BOUNDS_MS.indexOf(1_000);
  const even = histogram({ [index]: 10 });
  assert.equal(latencyPercentile(even, 50), 875);
  assert.equal(latencyPercentile(even, 100), 1_000);
  const skewed = histogram({ 0: 95, [index]: 5 });
  assert.ok(latencyPercentile(skewed, 50)! <= 50);
  assert.equal(latencyPercentile(skewed, 95), 50);
  assert.ok(latencyPercentile(skewed, 99)! > 750);
  const overflow = histogram({ [LATENCY_BOUNDS_MS.length]: 3 });
  assert.equal(latencyPercentile(overflow, 95), LATENCY_BOUNDS_MS[LATENCY_BOUNDS_MS.length - 1]);
});

test("foldHealth sums minute hashes per deployment and ignores malformed fields", () => {
  const counts = foldHealth([
    { "dep-a|ok": "3", "dep-a|l2": "3", "dep-b|fail": "2", "dep-b|trip": "1" },
    { "dep-a|ok": 1, "dep-a|fail": 1, "dep-a|l2": 1, "broken": "4", "dep-a|l999": "1", "dep-a|ok2": "x" },
  ]);
  const a = counts.get("dep-a")!;
  assert.equal(a.ok, 4);
  assert.equal(a.fail, 1);
  assert.equal(a.latency[2], 4);
  assert.equal(counts.get("dep-b")!.trips, 1);
  assert.equal(counts.has("broken"), false);
  const summary = summarizeHealth(a);
  assert.equal(summary.attempts, 5);
  assert.equal(summary.errorRate, 0.2);
});

test("two failures in a row start a cooldown that expires", async () => {
  resetProviderHealthMemory();
  recordFailure("dep-cool", NOW);
  assert.equal((await coolingDown(["dep-cool"], NOW)).size, 0);
  recordFailure("dep-cool", NOW + 1);
  assert.deepEqual([...(await coolingDown(["dep-cool", "dep-other"], NOW + 2))], ["dep-cool"]);
  assert.equal((await coolingDown(["dep-cool"], NOW + 1 + COOLDOWN_MS)).size, 0);
});

test("a failure with a reset time parks the deployment until then, at most seven days", async () => {
  resetProviderHealthMemory();
  recordFailure("dep-limited", NOW, NOW + 3_600_000);
  assert.deepEqual([...(await coolingDown(["dep-limited"], NOW + 3_599_999))], ["dep-limited"]);
  assert.equal((await coolingDown(["dep-limited"], NOW + 3_600_000)).size, 0);
  recordFailure("dep-far", NOW, NOW + 30 * 24 * 60 * 60_000);
  const far = (await deploymentHealth(["dep-far"], 1, NOW)).states.get("dep-far")!;
  assert.equal(far.cooldownUntil, NOW + MAX_LIMIT_COOLDOWN_MS);
  assert.equal(far.trips, 1);
  recordFailure("dep-past", NOW, NOW - 1);
  assert.equal((await coolingDown(["dep-past"], NOW)).size, 0);
});

test("a success between failures resets the failure streak", async () => {
  resetProviderHealthMemory();
  recordFailure("dep-flaky", NOW);
  recordSuccess("dep-flaky", 120, NOW);
  recordFailure("dep-flaky", NOW);
  assert.equal((await coolingDown(["dep-flaky"], NOW)).size, 0);
});

test("deploymentHealth reports attempts, latency, trips, and cooldowns inside the window", async () => {
  resetProviderHealthMemory();
  const old = NOW - 20 * 60_000;
  recordSuccess("dep-a", 400, old);
  recordSuccess("dep-a", 400, NOW);
  recordSuccess("dep-a", 600, NOW);
  recordFailure("dep-a", NOW);
  recordFailure("dep-b", NOW);
  recordFailure("dep-b", NOW);

  const recent = await deploymentHealth(["dep-a", "dep-b", "dep-idle"], 15, NOW);
  assert.equal(recent.backend, "memory");
  const a = summarizeHealth(recent.states.get("dep-a")!);
  assert.equal(a.attempts, 3);
  assert.equal(a.failures, 1);
  assert.ok(a.p50! > 300 && a.p50! <= 750);
  assert.equal(recent.states.get("dep-a")!.cooldownUntil, null);
  const b = recent.states.get("dep-b")!;
  assert.equal(b.trips, 1);
  assert.equal(b.cooldownUntil, NOW + COOLDOWN_MS);
  assert.equal(summarizeHealth(recent.states.get("dep-idle")!).attempts, 0);

  const hour = await deploymentHealth(["dep-a"], HEALTH_RETENTION_MINUTES, NOW);
  assert.equal(summarizeHealth(hour.states.get("dep-a")!).attempts, 4);
});

test("memory buckets older than the retention window are dropped", async () => {
  resetProviderHealthMemory();
  recordSuccess("dep-a", 100, NOW - (HEALTH_RETENTION_MINUTES + 5) * 60_000);
  recordSuccess("dep-a", 100, NOW);
  const health = await deploymentHealth(["dep-a"], HEALTH_RETENTION_MINUTES, NOW);
  assert.equal(summarizeHealth(health.states.get("dep-a")!).attempts, 1);
});
