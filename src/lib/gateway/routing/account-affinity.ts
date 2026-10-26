import "server-only";
import { createHash } from "node:crypto";
import { asRecord, asString } from "@/lib/gateway/core";
import { claudeCodeCacheKey, claudeCodeSessionKey } from "@/lib/gateway/protocols/messages";
import { isSignInKind } from "@/lib/gateway/upstreams/provider-kinds";
import { redisUrl } from "@/lib/jobs/connection";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { sharedRedis, withRedisTimeout } from "@/lib/redis/client";
import { parseJsonOrNull } from "@/lib/utils/json";
import type { JsonMap } from "@/types/gateway";
import type { AccountPin } from "@/types/routing";

export const PIN_TTL_MS = 6 * 3_600_000;
export const PIN_HOLD_MS = 60_000;
const PINNED_API_KINDS = new Set(["anthropic"]);
export const CLAUDE_CODE_SESSION_HEADER = "x-claude-code-session-id";
export const MAX_SESSION_LENGTH = 512;
const MAX_PINS = 20_000;
const KEY_PREFIX = "llmhub:account-pin:v1";
const SETTLE_PIN_SCRIPT = `
local current = redis.call('GET', KEYS[1])
local wanted = cjson.decode(ARGV[1])
if current then
  local ok, stored = pcall(cjson.decode, current)
  if ok and type(stored) == 'table' and type(stored.providerId) == 'string' and stored.providerId ~= ARGV[2] then
    if stored.providerId ~= wanted.providerId then return current end
    local held = tonumber(stored.handoffAt) or 0
    if held > wanted.handoffAt then wanted.handoffAt = held end
  end
end
local encoded = cjson.encode(wanted)
redis.call('SET', KEYS[1], encoded, 'PX', ARGV[3])
return encoded
`;

type StoredPin = AccountPin & { until: number };

const pinHolder = globalThis as typeof globalThis & { __llmhubAccountPins?: Map<string, StoredPin> };

function pins(): Map<string, StoredPin> {
  pinHolder.__llmhubAccountPins ??= new Map();
  return pinHolder.__llmhubAccountPins;
}

function pinKey(kind: string, session: string): string {
  return `${kind}:${session}`;
}

function sharedKey(key: string): string {
  return `${KEY_PREFIX}:${key}`;
}

export function pinsAccounts(kind: string): boolean {
  return isSignInKind(kind) || PINNED_API_KINDS.has(kind);
}

function headerValue(headers: Record<string, string> | undefined, name: string): string {
  if (!headers) return "";
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return found?.[1]?.trim() ?? "";
}

export function clientSessionKey(body: unknown, headers?: Record<string, string>): string {
  const rec = asRecord(body);
  const key =
    asString(rec?.prompt_cache_key).trim() ||
    claudeCodeCacheKey(rec?.metadata) ||
    claudeCodeSessionKey(headerValue(headers, CLAUDE_CODE_SESSION_HEADER));
  return key.length > MAX_SESSION_LENGTH ? "" : key;
}

export function runSession(body: JsonMap | null | undefined, headers?: Record<string, string>): string {
  const key = clientSessionKey(body, headers);
  if (!key) return "";
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

function pinOf(value: unknown): AccountPin | null {
  const rec = asRecord(value);
  const providerId = asString(rec?.providerId);
  const handoffAt = Number(rec?.handoffAt);
  if (!providerId || !Number.isInteger(handoffAt) || handoffAt < 0) return null;
  return { providerId, handoffAt };
}

function storedPin(raw: unknown): AccountPin | null {
  return typeof raw === "string" ? pinOf(parseJsonOrNull(raw)) : null;
}

function samePin(left: AccountPin | null, right: AccountPin | null): boolean {
  return left?.providerId === right?.providerId && left?.handoffAt === right?.handoffAt;
}

function settledPin(stored: AccountPin | null, wanted: AccountPin, expected: AccountPin | null): AccountPin {
  if (!stored || stored.providerId === expected?.providerId) return wanted;
  if (stored.providerId !== wanted.providerId) return stored;
  return { providerId: wanted.providerId, handoffAt: Math.max(stored.handoffAt, wanted.handoffAt) };
}

function localPin(key: string, now: number): AccountPin | null {
  const local = pins().get(key);
  if (!local) return null;
  if (local.until > now) return { providerId: local.providerId, handoffAt: local.handoffAt };
  pins().delete(key);
  return null;
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
  const local = localPin(key, now);
  if (!redisUrl()) return local;
  const redis = await sharedRedis();
  if (!redis) return local;
  try {
    const pin = storedPin(await withRedisTimeout(redis.get(sharedKey(key))));
    if (!pin) return local;
    if (!samePin(local, pin)) rememberLocally(key, pin, now);
    return pin;
  } catch (err) {
    logger.warn("account_pin.redis_fallback", errorFields(err));
    return local;
  }
}

export async function writePin(
  kind: string,
  session: string,
  wanted: AccountPin,
  expected: AccountPin | null,
  now = Date.now(),
): Promise<AccountPin | null> {
  if (!session) return null;
  const key = pinKey(kind, session);
  const redis = redisUrl() ? await sharedRedis() : null;
  if (redis) {
    try {
      const pin = storedPin(
        await withRedisTimeout(
          redis.eval(SETTLE_PIN_SCRIPT, 1, sharedKey(key), JSON.stringify(wanted), expected?.providerId ?? "", PIN_TTL_MS),
        ),
      );
      if (pin) {
        rememberLocally(key, pin, now);
        return pin;
      }
    } catch (err) {
      logger.warn("account_pin.redis_fallback", errorFields(err));
    }
  }
  const pin = settledPin(localPin(key, now), wanted, expected);
  rememberLocally(key, pin, now);
  return pin;
}

export function forgetPins(): void {
  pins().clear();
}
