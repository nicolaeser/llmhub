import "server-only";
import { redisCounter } from "@/lib/rate-limit/shared";
import type { RequestWindow } from "@/types/security";

const KEY_PREFIX = "llmhub:limit:v1";
export const MAX_MEMORY_WINDOWS = 10_000;
const windows = new Map<string, RequestWindow>();

export function allowInMemory(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  let entry = windows.get(key);
  if (!entry || entry.resetAt <= now) {
    if (!entry && windows.size >= MAX_MEMORY_WINDOWS) {
      for (const [known, value] of windows) {
        if (value.resetAt <= now) windows.delete(known);
      }
      if (windows.size >= MAX_MEMORY_WINDOWS) return false;
    }
    entry = { count: 0, resetAt: now + windowMs };
    windows.set(key, entry);
  }
  entry.count += 1;
  return entry.count <= limit;
}

export async function allowRequest(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): Promise<boolean> {
  const slot = Math.floor(now / windowMs);
  const count = await redisCounter(`${KEY_PREFIX}:${key}:${slot}`, Math.ceil((windowMs * 2) / 1000));
  if (count !== null) return count <= limit;
  return allowInMemory(key, limit, windowMs, now);
}

export function resetRequestWindows(): void {
  windows.clear();
}
