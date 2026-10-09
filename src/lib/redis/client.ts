import "server-only";
import { redisUrl } from "@/lib/jobs/connection";
import { logger } from "@/lib/logging/logger";
import type { RedisLike } from "@/types/gateway";

const REDIS_DECISION_TIMEOUT_MS = 2_000;
const globalForRedis = globalThis as unknown as {
  __llmhubRedis?: Promise<RedisLike | null>;
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

async function connect(url: string): Promise<RedisLike | null> {
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
      logger.warn("redis.error", {
        err: err instanceof Error ? err.message : String(err),
      });
    });
    await withRedisTimeout(client.connect());
    return client;
  } catch (err) {
    logger.warn("redis.unavailable", {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function sharedRedis(): Promise<RedisLike | null> {
  const url = redisUrl();
  if (!url) return Promise.resolve(null);
  globalForRedis.__llmhubRedis ??= connect(url);
  return globalForRedis.__llmhubRedis;
}
