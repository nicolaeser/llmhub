import "server-only";
import type { Redis } from "ioredis";
import { redisUrl } from "@/lib/jobs/connection";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { sharedRedis, withRedisTimeout } from "@/lib/redis/client";

export const MAX_PINS = 20_000;

type HeldPin = { value: unknown; until: number };

type SharedRead<T> = { value: T };

const pinHolder = globalThis as typeof globalThis & { __llmhubPinStores?: Map<string, Map<string, HeldPin>> };

function localStore(name: string): Map<string, HeldPin> {
  pinHolder.__llmhubPinStores ??= new Map();
  let store = pinHolder.__llmhubPinStores.get(name);
  if (!store) {
    store = new Map();
    pinHolder.__llmhubPinStores.set(name, store);
  }
  return store;
}

export class PinStore<T> {
  constructor(
    private readonly name: string,
    private readonly prefix: string,
    private readonly fallbackEvent: string,
  ) {}

  sharedKey(key: string): string {
    return `${this.prefix}:${key}`;
  }

  local(key: string, now: number): T | null {
    const store = localStore(this.name);
    const held = store.get(key);
    if (!held) return null;
    if (held.until > now) return held.value as T;
    store.delete(key);
    return null;
  }

  remember(key: string, value: T, ttlMs: number, now: number): void {
    const store = localStore(this.name);
    store.delete(key);
    store.set(key, { value, until: now + ttlMs });
    while (store.size > MAX_PINS) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) break;
      store.delete(oldest);
    }
  }

  async shared<R>(work: (redis: Redis) => Promise<R>): Promise<SharedRead<R> | null> {
    if (!redisUrl()) return null;
    const redis = await sharedRedis();
    if (!redis) return null;
    try {
      return { value: await withRedisTimeout(work(redis)) };
    } catch (err) {
      logger.warn(this.fallbackEvent, errorFields(err));
      return null;
    }
  }

  forget(): void {
    localStore(this.name).clear();
  }
}
