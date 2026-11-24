import "server-only";
import { createHash } from "node:crypto";
import { asRecord, asString } from "@/lib/gateway/core";
import { claudeCodeCacheKey, claudeCodeSessionKey } from "@/lib/gateway/protocols/messages";
import { PinStore } from "@/lib/gateway/routing/pin-store";
import { PROVIDER_CATALOG } from "@/lib/gateway/upstreams/provider-kinds";
import { parseJsonOrNull } from "@/lib/utils/json";
import type { JsonMap } from "@/types/gateway";
import type { AccountPin } from "@/types/routing";

export const PIN_TTL_MS = 6 * 3_600_000;
export const PIN_HOLD_MS = 60_000;
export const CLAUDE_CODE_SESSION_HEADER = "x-claude-code-session-id";
export const MAX_SESSION_LENGTH = 512;
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

const accountPins = new PinStore<AccountPin>("account", KEY_PREFIX, "account_pin.redis_fallback");

function pinKey(kind: string, session: string): string {
  return `${kind}:${session}`;
}

export function pinsAccounts(kind: string): boolean {
  return PROVIDER_CATALOG.some((spec) => spec.kind === kind);
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
  const local = accountPins.local(key, now);
  return local ? { providerId: local.providerId, handoffAt: local.handoffAt } : null;
}

function rememberLocally(key: string, pin: AccountPin, now: number): void {
  accountPins.remember(key, { providerId: pin.providerId, handoffAt: pin.handoffAt }, PIN_TTL_MS, now);
}

export async function readPin(kind: string, session: string, now = Date.now()): Promise<AccountPin | null> {
  if (!session) return null;
  const key = pinKey(kind, session);
  const local = localPin(key, now);
  const shared = await accountPins.shared((redis) => redis.get(accountPins.sharedKey(key)));
  const pin = shared ? storedPin(shared.value) : null;
  if (!pin) return local;
  if (!samePin(local, pin)) rememberLocally(key, pin, now);
  return pin;
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
  const shared = await accountPins.shared((redis) =>
    redis.eval(SETTLE_PIN_SCRIPT, 1, accountPins.sharedKey(key), JSON.stringify(wanted), expected?.providerId ?? "", PIN_TTL_MS),
  );
  const settled = shared ? storedPin(shared.value) : null;
  if (settled) {
    rememberLocally(key, settled, now);
    return settled;
  }
  const pin = settledPin(localPin(key, now), wanted, expected);
  rememberLocally(key, pin, now);
  return pin;
}

export function forgetPins(): void {
  accountPins.forget();
}
