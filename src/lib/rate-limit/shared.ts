import "server-only";
import { redisUrl } from "@/lib/jobs/connection";
import { logger } from "@/lib/logging/logger";
import type { Bucket, RedisLike } from "@/types/gateway";

const WINDOW_MS = 60_000;
const REDIS_DECISION_TIMEOUT_MS = 2_000;
const REDIS_KEY_PREFIX = "llmhub:rate:v1";
const memory = new Map<string, Bucket>();
const globalForRate = globalThis as unknown as {
  __llmhubRateRedis?: RedisLike | null;
  __llmhubRateRedisTried?: boolean;
};

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("redis timeout")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function getRedis(): Promise<RedisLike | null> {
  if (globalForRate.__llmhubRateRedis) return globalForRate.__llmhubRateRedis;
  if (globalForRate.__llmhubRateRedisTried) return null;
  const url = redisUrl();
  if (!url) return null;
  globalForRate.__llmhubRateRedisTried = true;
  try {
    const { default: IORedis } = await import("ioredis");
    const client = new IORedis(url, {
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
      commandTimeout: 2_000,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    client.on("error", (err) => {
      logger.warn("rate_limit.redis_error", {
        err: err instanceof Error ? err.message : String(err),
      });
    });
    await withTimeout(client.connect(), REDIS_DECISION_TIMEOUT_MS);
    globalForRate.__llmhubRateRedis = client;
    return client;
  } catch (err) {
    logger.warn("rate_limit.redis_unavailable", {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function memoryIncrement(id: string, requests: number, tokens: number, now: number): Bucket {
  let bucket = memory.get(id);
  if (!bucket || now - bucket.start > WINDOW_MS) {
    bucket = { start: now, rpm: 0, tpm: 0 };
  }
  bucket.rpm += requests;
  bucket.tpm += tokens;
  memory.set(id, bucket);
  return bucket;
}

function redisKey(id: string, kind: "rpm" | "tpm", minute: number): string {
  return `${REDIS_KEY_PREFIX}:${id}:${minute}:${kind}`;
}

export async function incrementRateWindow(
  id: string,
  requests: number,
  tokens: number,
  now = Date.now(),
): Promise<{ rpm: number; tpm: number; backend: "redis" | "memory" }> {
  const redis = await getRedis();
  if (redis) {
    const minute = Math.floor(now / WINDOW_MS);
    const rpmKey = redisKey(id, "rpm", minute);
    const tpmKey = redisKey(id, "tpm", minute);
    try {
      const rpm = await withTimeout(redis.incrby(rpmKey, requests), REDIS_DECISION_TIMEOUT_MS);
      if (rpm === requests) await redis.expire(rpmKey, 120);
      const tpm = await withTimeout(redis.incrby(tpmKey, tokens), REDIS_DECISION_TIMEOUT_MS);
      if (tpm === tokens) await redis.expire(tpmKey, 120);
      return { rpm, tpm, backend: "redis" };
    } catch (err) {
      logger.warn("rate_limit.redis_fallback", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const bucket = memoryIncrement(id, requests, tokens, now);
  return { rpm: bucket.rpm, tpm: bucket.tpm, backend: "memory" };
}

export async function redisCounter(key: string, ttlSeconds: number): Promise<number | null> {
  const redis = await getRedis();
  if (!redis) return null;
  try {
    const count = await withTimeout(redis.incrby(key, 1), REDIS_DECISION_TIMEOUT_MS);
    if (count === 1) await withTimeout(redis.expire(key, ttlSeconds), REDIS_DECISION_TIMEOUT_MS);
    return count;
  } catch (err) {
    logger.warn("rate_limit.redis_fallback", {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function resetRateLimitMemory(): void {
  memory.clear();
}
