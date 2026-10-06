import "server-only";
import { digest } from "@/lib/crypto";
import type { Entry } from "@/types/gateway";

const MAX_ENTRIES = 1000;
const store = new Map<string, Entry>();

export function cacheGet(key: string): Uint8Array | null {
  const hit = store.get(key);
  if (!hit) return null;
  store.delete(key);
  if (hit.expires < Date.now()) return null;
  store.set(key, hit);
  return hit.body;
}

export function cachePut(key: string, body: Uint8Array, ttlSeconds: number): void {
  if (ttlSeconds <= 0) return;
  store.delete(key);
  store.set(key, { body, expires: Date.now() + ttlSeconds * 1000 });
  const now = Date.now();
  for (const [entryKey, entry] of store) {
    if (store.size <= MAX_ENTRIES && entry.expires >= now) break;
    store.delete(entryKey);
  }
}

export function cacheBypassed(headers: Headers, body: Record<string, unknown>): boolean {
  const bypass = headers.get("x-hub-bypass-cache");
  if (bypass === "true" || bypass === "1") return true;
  if (headers.get("cache-control")?.toLowerCase().includes("no-cache")) return true;
  if (body.stream === true) return true;
  const cache = body.cache;
  if (cache === false) return true;
  if (cache && typeof cache === "object" && !Array.isArray(cache)) {
    const rec = cache as Record<string, unknown>;
    if (rec["no-cache"] === true || rec.bypass === true || rec.ttl === 0) return true;
  }
  return false;
}

export function cacheKey(owner: string, model: string, raw: string): string {
  return digest(`${owner}\n${model}\n${raw}`);
}
