import "server-only";

import type { ConnectionOptions } from "bullmq";

export function redisUrl(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string | undefined {
  return env.REDIS_URL?.trim() || undefined;
}

export function jobsEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(redisUrl(env));
}

export function getQueueConnectionOptions(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): ConnectionOptions {
  const url = redisUrl(env);
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
