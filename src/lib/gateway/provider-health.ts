import "server-only";
import { redisUrl } from "@/lib/jobs/connection";
import { logger } from "@/lib/logging/logger";
import { sharedRedis, withRedisTimeout } from "@/lib/redis/client";
import type {
  HealthBackend,
  HealthCounts,
  HealthState,
  HealthSummary,
} from "@/types/provider-health";

export const COOLDOWN_MS = 15_000;
export const MAX_LIMIT_COOLDOWN_MS = 7 * 24 * 60 * 60_000;
export const HEALTH_RETENTION_MINUTES = 60;
export const LATENCY_BOUNDS_MS = [
  50, 100, 200, 300, 500, 750, 1_000, 1_500, 2_000, 3_000, 5_000, 7_500, 10_000, 15_000, 20_000,
  30_000, 45_000, 60_000, 90_000, 120_000, 180_000, 300_000,
] as const;
const ALLOWED_FAILS = 2;
const MINUTE_MS = 60_000;
const MINUTE_TTL_SECONDS = (HEALTH_RETENTION_MINUTES + 2) * 60;
const KEY_PREFIX = "llmhub:health:v1";

type HealthMemory = {
  failCount: Map<string, number>;
  cooldownUntil: Map<string, number>;
  minutes: Map<number, Map<string, number>>;
};

const globalForHealth = globalThis as unknown as { __llmhubProviderHealth?: HealthMemory };

function memory(): HealthMemory {
  globalForHealth.__llmhubProviderHealth ??= {
    failCount: new Map(),
    cooldownUntil: new Map(),
    minutes: new Map(),
  };
  return globalForHealth.__llmhubProviderHealth;
}

function minuteKey(minute: number): string {
  return `${KEY_PREFIX}:minute:${minute}`;
}

function cooldownKey(id: string): string {
  return `${KEY_PREFIX}:cooldown:${id}`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function latencyBucket(ms: number): number {
  const index = LATENCY_BOUNDS_MS.findIndex((bound) => ms <= bound);
  return index === -1 ? LATENCY_BOUNDS_MS.length : index;
}

export function latencyPercentile(histogram: number[], p: number): number | null {
  const total = histogram.reduce((sum, n) => sum + n, 0);
  if (!total) return null;
  const rank = (p / 100) * total;
  let seen = 0;
  for (let index = 0; index < histogram.length; index++) {
    const n = histogram[index] ?? 0;
    if (!n) continue;
    if (seen + n >= rank) {
      const lower = index === 0 ? 0 : LATENCY_BOUNDS_MS[index - 1]!;
      const upper = LATENCY_BOUNDS_MS[index];
      if (upper === undefined) return lower;
      return lower + ((upper - lower) * Math.max(0, rank - seen)) / n;
    }
    seen += n;
  }
  return LATENCY_BOUNDS_MS[LATENCY_BOUNDS_MS.length - 1];
}

export function summarizeHealth(counts: HealthCounts): HealthSummary {
  const attempts = counts.ok + counts.fail;
  return {
    attempts,
    failures: counts.fail,
    errorRate: attempts ? counts.fail / attempts : 0,
    p50: latencyPercentile(counts.latency, 50),
    p95: latencyPercentile(counts.latency, 95),
    trips: counts.trips,
  };
}

function emptyCounts(): HealthCounts {
  return { ok: 0, fail: 0, trips: 0, latency: new Array(LATENCY_BOUNDS_MS.length + 1).fill(0) };
}

export function foldHealth(hashes: Record<string, string | number>[]): Map<string, HealthCounts> {
  const out = new Map<string, HealthCounts>();
  for (const hash of hashes) {
    for (const [field, raw] of Object.entries(hash)) {
      const split = field.lastIndexOf("|");
      const n = Number(raw);
      if (split <= 0 || !Number.isFinite(n)) continue;
      const id = field.slice(0, split);
      const metric = field.slice(split + 1);
      const counts = out.get(id) ?? emptyCounts();
      if (metric === "ok") counts.ok += n;
      else if (metric === "fail") counts.fail += n;
      else if (metric === "trip") counts.trips += n;
      else if (metric.startsWith("l")) {
        const bucket = Number(metric.slice(1));
        if (Number.isInteger(bucket) && bucket >= 0 && bucket < counts.latency.length) {
          counts.latency[bucket]! += n;
        }
      }
      out.set(id, counts);
    }
  }
  return out;
}

function countInMemory(fields: string[], minute: number): void {
  const minutes = memory().minutes;
  const slot = minutes.get(minute) ?? new Map<string, number>();
  for (const field of fields) slot.set(field, (slot.get(field) ?? 0) + 1);
  minutes.set(minute, slot);
  for (const known of minutes.keys()) {
    if (known <= minute - HEALTH_RETENTION_MINUTES) minutes.delete(known);
  }
}

async function countShared(fields: string[], minute: number): Promise<void> {
  const redis = await sharedRedis();
  if (redis) {
    const key = minuteKey(minute);
    try {
      await withRedisTimeout(
        Promise.all([
          ...fields.map((field) => redis.hincrby(key, field, 1)),
          redis.expire(key, MINUTE_TTL_SECONDS),
        ]),
      );
      return;
    } catch (err) {
      logger.warn("provider_health.redis_fallback", { err: errText(err) });
    }
  }
  countInMemory(fields, minute);
}

function count(fields: string[], now: number): void {
  const minute = Math.floor(now / MINUTE_MS);
  if (!redisUrl()) {
    countInMemory(fields, minute);
    return;
  }
  void countShared(fields, minute);
}

async function shareCooldown(id: string, until: number, now: number): Promise<void> {
  const redis = await sharedRedis();
  if (!redis) return;
  try {
    const ttlMs = Math.max(1, Math.ceil(until - now));
    await withRedisTimeout(redis.set(cooldownKey(id), String(until), "PX", ttlMs));
  } catch (err) {
    logger.warn("provider_health.redis_fallback", { err: errText(err) });
  }
}

export function recordSuccess(id: string, latencyMs?: number, now = Date.now()): void {
  memory().failCount.delete(id);
  const fields = [`${id}|ok`];
  if (latencyMs != null && latencyMs >= 0) fields.push(`${id}|l${latencyBucket(latencyMs)}`);
  count(fields, now);
}

export function recordFailure(id: string, now = Date.now(), retryAt: number | null = null): void {
  const state = memory();
  const fails = (state.failCount.get(id) ?? 0) + 1;
  const fields = [`${id}|fail`];
  const limited = retryAt != null && retryAt > now;
  if (limited || fails >= ALLOWED_FAILS) {
    const until = limited ? Math.min(retryAt, now + MAX_LIMIT_COOLDOWN_MS) : now + COOLDOWN_MS;
    state.failCount.delete(id);
    state.cooldownUntil.set(id, until);
    fields.push(`${id}|trip`);
    if (redisUrl()) void shareCooldown(id, until, now);
  } else {
    state.failCount.set(id, fails);
  }
  count(fields, now);
}

export async function coolingDown(ids: string[], now = Date.now()): Promise<Set<string>> {
  const local = memory().cooldownUntil;
  const cooling = new Set(ids.filter((id) => (local.get(id) ?? 0) > now));
  const open = ids.filter((id) => !cooling.has(id));
  if (!open.length || !redisUrl()) return cooling;
  const redis = await sharedRedis();
  if (!redis) return cooling;
  try {
    const values = await withRedisTimeout(redis.mget(open.map(cooldownKey)));
    values.forEach((value, index) => {
      if (Number(value) > now) cooling.add(open[index]!);
    });
  } catch (err) {
    logger.warn("provider_health.redis_fallback", { err: errText(err) });
  }
  return cooling;
}

export async function deploymentHealth(
  ids: string[],
  minutes: number,
  now = Date.now(),
): Promise<{ backend: HealthBackend; states: Map<string, HealthState> }> {
  const span = Math.min(HEALTH_RETENTION_MINUTES, Math.max(1, Math.trunc(minutes) || 1));
  const current = Math.floor(now / MINUTE_MS);
  const slots = Array.from({ length: span }, (_, offset) => current - offset);
  const state = memory();
  let backend: HealthBackend = "memory";
  let hashes: Record<string, string | number>[] | null = null;
  let shared: (string | null)[] = [];
  const redis = redisUrl() ? await sharedRedis() : null;
  if (redis) {
    try {
      [hashes, shared] = await withRedisTimeout(
        Promise.all([
          Promise.all(slots.map((slot) => redis.hgetall(minuteKey(slot)))),
          ids.length ? redis.mget(ids.map(cooldownKey)) : Promise.resolve([]),
        ]),
      );
      backend = "redis";
    } catch (err) {
      logger.warn("provider_health.redis_fallback", { err: errText(err) });
      hashes = null;
      shared = [];
    }
  }
  const counts = foldHealth(
    hashes ?? slots.map((slot) => Object.fromEntries(state.minutes.get(slot) ?? [])),
  );
  const states = new Map<string, HealthState>();
  ids.forEach((id, index) => {
    const until = Math.max(state.cooldownUntil.get(id) ?? 0, Number(shared[index]) || 0);
    states.set(id, { ...(counts.get(id) ?? emptyCounts()), cooldownUntil: until > now ? until : null });
  });
  return { backend, states };
}

export function resetProviderHealthMemory(): void {
  const state = memory();
  state.failCount.clear();
  state.cooldownUntil.clear();
  state.minutes.clear();
}
