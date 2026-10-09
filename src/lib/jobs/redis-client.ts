import "server-only";
import type { Redis } from "ioredis";
import { redisUrl } from "@/lib/jobs/connection";
import { logger } from "@/lib/logging/logger";

const CONNECT_TIMEOUT_MS = 2_000;
const RECONNECT_AFTER_MS = 30_000;
const globalForRedis = globalThis as unknown as {
  __llmhubRedis?: Redis;
  __llmhubRedisRetryAt?: number;
};

export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
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

export async function sharedRedis(now = Date.now()): Promise<Redis | null> {
  if (globalForRedis.__llmhubRedis) return globalForRedis.__llmhubRedis;
  const url = redisUrl();
  if (!url) return null;
  if ((globalForRedis.__llmhubRedisRetryAt ?? 0) > now) return null;
  globalForRedis.__llmhubRedisRetryAt = now + RECONNECT_AFTER_MS;
  const { default: IORedis } = await import("ioredis");
  const client = new IORedis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: CONNECT_TIMEOUT_MS,
    commandTimeout: CONNECT_TIMEOUT_MS,
    enableOfflineQueue: false,
    lazyConnect: true,
  });
  client.on("error", (err) => {
    logger.warn("redis.error", { err: err instanceof Error ? err.message : String(err) });
  });
  try {
    await withTimeout(client.connect(), CONNECT_TIMEOUT_MS);
    globalForRedis.__llmhubRedis = client;
    return client;
  } catch (err) {
    client.disconnect();
    logger.warn("redis.unavailable", { err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
