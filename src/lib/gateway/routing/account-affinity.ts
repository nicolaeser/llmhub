import "server-only";
import { createHash } from "node:crypto";
import { asRecord, asString } from "@/lib/gateway/core";
import { claudeCodeCacheKey } from "@/lib/gateway/protocols/messages";
import { redisUrl } from "@/lib/jobs/connection";
import { logger } from "@/lib/logging/logger";
import { sharedRedis, withRedisTimeout } from "@/lib/redis/client";
import type { JsonMap } from "@/types/gateway";
import type { AccountPin } from "@/types/routing";

export const PIN_TTL_MS = 6 * 3_600_000;
const MAX_PINS = 20_000;
const MAX_SESSION_LENGTH = 512;
const KEY_PREFIX = "llmhub:account-pin:v1";

type StoredPin = AccountPin & { until: number };

const pinHolder = globalThis as typeof globalThis & { __llmhubAccountPins?: Map<string, StoredPin> };

function pins(): Map<string, StoredPin> {
  pinHolder.__llmhubAccountPins ??= new Map();
  return pinHolder.__llmhubAccountPins;
}

function pinKey(kind: string, session: string): string {
  return `${kind}:${session}`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function runSession(body: JsonMap | null | undefined): string {
  const rec = asRecord(body);
  const key = asString(rec?.prompt_cache_key).trim() || claudeCodeCacheKey(rec?.metadata);
  if (!key || key.length > MAX_SESSION_LENGTH) return "";
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

function pinOf(value: unknown): AccountPin | null {
  const rec = asRecord(value);
  const providerId = asString(rec?.providerId);
  const handoffAt = Number(rec?.handoffAt);
  if (!providerId || !Number.isInteger(handoffAt) || handoffAt < 0) return null;
  return { providerId, handoffAt };
}

function rememberLocally(key: string, pin: AccountPin, now: number): void {
  const store = pins();
  store.delete(key);
  store.set(key, { ...pin, until: now + PIN_TTL_MS });
  while (store.size > MAX_PINS) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

export async function readPin(kind: string, session: string, now = Date.now()): Promise<AccountPin | null> {
  if (!session) return null;
  const key = pinKey(kind, session);
  const local = pins().get(key);
  if (local && local.until > now) return { providerId: local.providerId, handoffAt: local.handoffAt };
  if (local) pins().delete(key);
  if (!redisUrl()) return null;
  const redis = await sharedRedis();
  if (!redis) return null;
  try {
    const raw = await withRedisTimeout(redis.get(`${KEY_PREFIX}:${key}`));
    const pin = raw ? pinOf(JSON.parse(raw)) : null;
    if (pin) rememberLocally(key, pin, now);
    return pin;
  } catch (err) {
    logger.warn("account_pin.redis_fallback", { err: errText(err) });
    return null;
  }
}

export async function writePin(kind: string, session: string, pin: AccountPin, now = Date.now()): Promise<void> {
  if (!session) return;
  const key = pinKey(kind, session);
  rememberLocally(key, pin, now);
  if (!redisUrl()) return;
  const redis = await sharedRedis();
  if (!redis) return;
  try {
    await withRedisTimeout(redis.set(`${KEY_PREFIX}:${key}`, JSON.stringify(pin), "PX", PIN_TTL_MS));
  } catch (err) {
    logger.warn("account_pin.redis_fallback", { err: errText(err) });
  }
}

export function forgetPins(): void {
  pins().clear();
}
