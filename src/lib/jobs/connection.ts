import "server-only";

import type { ConnectionOptions } from "bullmq";
import { env } from "@/lib/env";
import { envSchema } from "@/schemas/env";

const redisSetting = envSchema.pick({ REDIS_URL: true });

export function redisUrl(source?: Record<string, string | undefined>): string | undefined {
  return source ? redisSetting.parse(source).REDIS_URL : env.REDIS_URL;
}

export function jobsEnabled(source?: Record<string, string | undefined>): boolean {
  return Boolean(redisUrl(source));
}

export function getQueueConnectionOptions(): ConnectionOptions {
  const url = redisUrl();
  if (!url) {
    throw new Error("Redis is not configured");
  }
  return {
    url,
    maxRetriesPerRequest: null,
    connectTimeout: 5_000,
    enableOfflineQueue: false,
  };
}
