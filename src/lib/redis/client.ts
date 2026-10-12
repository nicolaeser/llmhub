import "server-only";
import type { Redis } from "ioredis";
import { redisUrl } from "@/lib/jobs/connection";
import { logger } from "@/lib/logging/logger";

const REDIS_DECISION_TIMEOUT_MS = 2_000;
const RECONNECT_AFTER_MS = 30_000;
const globalForRedis = globalThis as unknown as {
  __llmhubRedis?: Promise<Redis | null>;
  __llmhubRedisRetryAt?: number;
};

export async function withRedisTimeout<T>(promise: Promise<T>, ms = REDIS_DECISION_TIMEOUT_MS): Promise<T> {
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

async function connect(url: string): Promise<Redis | null> {
  let client: Redis | undefined;
  try {
    const { default: IORedis } = await import("ioredis");
    client = new IORedis(url, {
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
      commandTimeout: 2_000,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    client.on("error", (err) => {
      logger.warn("redis.error", {
        err: err instanceof Error ? err.message : String(err),
      });
    });
    await withRedisTimeout(client.connect());
    return client;
  } catch (err) {
    client?.disconnect();
    globalForRedis.__llmhubRedisRetryAt = Date.now() + RECONNECT_AFTER_MS;
    logger.warn("redis.unavailable", {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function sharedRedis(now = Date.now()): Promise<Redis | null> {
  const url = redisUrl();
  if (!url) return Promise.resolve(null);
  const retryAt = globalForRedis.__llmhubRedisRetryAt;
  if (retryAt !== undefined && retryAt <= now) {
    globalForRedis.__llmhubRedis = undefined;
    globalForRedis.__llmhubRedisRetryAt = undefined;
  }
  globalForRedis.__llmhubRedis ??= connect(url);
  return globalForRedis.__llmhubRedis;
}
