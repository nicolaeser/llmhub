import "server-only";
import type { ChainableCommander, Redis } from "ioredis";
import { digest } from "@/lib/crypto";
import { asNumber, asRecord } from "@/lib/gateway/core";
import { redisUrl } from "@/lib/jobs/connection";
import { sharedRedis, withRedisTimeout } from "@/lib/redis/client";
import { logger } from "@/lib/logging/logger";
import type { CacheBackend, CachedResponse, SemanticMatch, SemanticProbe } from "@/types/cache";
import type { JsonMap } from "@/types/gateway";

const MAX_MEMORY_ENTRIES = 1000;
const MAX_MEMORY_SCOPES = 50;
const MAX_SHARED_ENTRIES = 10_000;
const MAX_ENTRY_BYTES = 512 * 1024;
const SEMANTIC_CANDIDATES = 50;
const SEMANTIC_TEXT_LIMIT = 8_000;
const REDIS_CACHE_TIMEOUT_MS = 1_000;
const KEY_PREFIX = "llmhub:cache:v1";
const INDEX_KEY = `${KEY_PREFIX}:index`;

type MemoryEntry = { value: string; expires: number };
type MemoryScope = { expires: number; items: { key: string; vector: Float32Array }[] };

const entries = new Map<string, MemoryEntry>();
const scopes = new Map<string, MemoryScope>();

function entryKey(key: string): string {
  return `${KEY_PREFIX}:entry:${key}`;
}

function vectorKey(key: string): string {
  return `${KEY_PREFIX}:vector:${key}`;
}

function scopeKey(scope: string): string {
  return `${KEY_PREFIX}:scope:${scope}`;
}

async function viaRedis<T>(op: string, run: (redis: Redis) => Promise<T>): Promise<T | undefined> {
  const redis = await sharedRedis();
  if (!redis) return undefined;
  try {
    return await withRedisTimeout(run(redis), REDIS_CACHE_TIMEOUT_MS);
  } catch (err) {
    logger.warn("cache.redis_fallback", { op, err: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}

async function execAll(commands: ChainableCommander): Promise<unknown[]> {
  const results = (await commands.exec()) ?? [];
  const failed = results.find(([err]) => err);
  if (failed?.[0]) throw failed[0];
  return results.map(([, value]) => value);
}

function parseEntry(value: string | null | undefined): CachedResponse | null {
  if (!value) return null;
  try {
    const rec = asRecord(JSON.parse(value));
    const response = asRecord(rec?.response);
    if (!rec || !response) return null;
    return { response, cost: asNumber(rec.cost), tokens: asNumber(rec.tokens) };
  } catch {
    return null;
  }
}

function memoryGet(key: string, now: number): string | null {
  const hit = entries.get(key);
  if (!hit) return null;
  entries.delete(key);
  if (hit.expires < now) return null;
  entries.set(key, hit);
  return hit.value;
}

function memoryPut(key: string, value: string, expires: number, now: number): void {
  entries.delete(key);
  entries.set(key, { value, expires });
  for (const [entry, stored] of entries) {
    if (entries.size <= MAX_MEMORY_ENTRIES && stored.expires >= now) break;
    entries.delete(entry);
  }
}

async function evictShared(redis: Redis, count: number): Promise<void> {
  const victims = await redis.zrange(INDEX_KEY, "0", String(count - 1));
  if (!victims.length) return;
  await execAll(
    redis
      .multi()
      .zrem(INDEX_KEY, ...victims)
      .del(...victims.flatMap((key) => [entryKey(key), vectorKey(key)])),
  );
}

export async function cacheGet(key: string, now = Date.now()): Promise<CachedResponse | null> {
  const shared = await viaRedis("get", (redis) => redis.get(entryKey(key)));
  if (shared !== undefined) return parseEntry(shared);
  return parseEntry(memoryGet(key, now));
}

export async function cachePut(
  key: string,
  entry: CachedResponse,
  ttlSeconds: number,
  now = Date.now(),
): Promise<boolean> {
  if (ttlSeconds <= 0) return false;
  const value = JSON.stringify(entry);
  if (Buffer.byteLength(value) > MAX_ENTRY_BYTES) return false;
  const ttlMs = ttlSeconds * 1000;
  const shared = await viaRedis("put", async (redis) => {
    const results = await execAll(
      redis
        .multi()
        .set(entryKey(key), value, "PX", ttlMs)
        .zadd(INDEX_KEY, now + ttlMs, key)
        .zremrangebyscore(INDEX_KEY, "-inf", now)
        .zcard(INDEX_KEY),
    );
    const size = Number(results.at(-1) ?? 0);
    if (size > MAX_SHARED_ENTRIES) await evictShared(redis, size - MAX_SHARED_ENTRIES);
    return true;
  });
  if (shared !== undefined) return shared;
  memoryPut(key, value, now + ttlMs, now);
  return true;
}

function promptText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const texts = content.flatMap((part) => {
    const rec = asRecord(part);
    return rec?.type === "text" && typeof rec.text === "string" ? [rec.text] : [];
  });
  return texts.length === content.length ? texts.join("\n").trim() : "";
}

export function semanticProbe(
  owner: string,
  model: string,
  embeddingModel: string,
  body: JsonMap,
): SemanticProbe | null {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const last = asRecord(messages.at(-1));
  if (!last || last.role !== "user") return null;
  const text = promptText(last.content);
  if (!text || text.length > SEMANTIC_TEXT_LIMIT) return null;
  const context = JSON.stringify({ ...body, messages: [...messages.slice(0, -1), { ...last, content: null }] });
  return { scope: digest(`${owner}\n${model}\n${embeddingModel}\n${context}`), text };
}

export function unitVector(values: unknown): Float32Array | null {
  if (!Array.isArray(values) || !values.length) return null;
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  const numbers = values as number[];
  const norm = Math.sqrt(numbers.reduce((sum, value) => sum + value * value, 0));
  if (!norm) return null;
  return Float32Array.from(numbers, (value) => value / norm);
}

export function similarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return -1;
  return a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);
}

function vectorBytes(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function vectorFrom(bytes: Buffer | null | undefined): Float32Array | null {
  if (!bytes || !bytes.byteLength || bytes.byteLength % 4) return null;
  return new Float32Array(new Uint8Array(bytes).buffer);
}

function bestMatch(
  candidates: { key: string; vector: Float32Array | null }[],
  vector: Float32Array,
  threshold: number,
): SemanticMatch | null {
  let best: SemanticMatch | null = null;
  for (const candidate of candidates) {
    if (!candidate.vector) continue;
    const score = similarity(candidate.vector, vector);
    if (score >= threshold && (!best || score > best.similarity)) {
      best = { key: candidate.key, similarity: score };
    }
  }
  return best;
}

export async function semanticFind(
  scope: string,
  vector: Float32Array,
  threshold: number,
  now = Date.now(),
): Promise<SemanticMatch | null> {
  const shared = await viaRedis("semantic_find", async (redis) => {
    const keys = await redis.lrange(scopeKey(scope), 0, SEMANTIC_CANDIDATES - 1);
    if (!keys.length) return null;
    const vectors = await redis.mgetBuffer(keys.map(vectorKey));
    return bestMatch(
      keys.map((key, index) => ({ key, vector: vectorFrom(vectors[index]) })),
      vector,
      threshold,
    );
  });
  if (shared !== undefined) return shared;
  const local = scopes.get(scope);
  if (!local || local.expires < now) return null;
  return bestMatch(local.items, vector, threshold);
}

export async function semanticAdd(
  scope: string,
  key: string,
  vector: Float32Array,
  ttlSeconds: number,
  now = Date.now(),
): Promise<void> {
  if (ttlSeconds <= 0) return;
  const ttlMs = ttlSeconds * 1000;
  const shared = await viaRedis("semantic_add", async (redis) => {
    await execAll(
      redis
        .multi()
        .set(vectorKey(key), vectorBytes(vector), "PX", ttlMs)
        .lrem(scopeKey(scope), 0, key)
        .lpush(scopeKey(scope), key)
        .ltrim(scopeKey(scope), 0, SEMANTIC_CANDIDATES - 1)
        .pexpire(scopeKey(scope), ttlMs),
    );
    return true;
  });
  if (shared !== undefined) return;
  const current = scopes.get(scope);
  const kept = current && current.expires >= now ? current.items.filter((item) => item.key !== key) : [];
  scopes.delete(scope);
  scopes.set(scope, { expires: now + ttlMs, items: [{ key, vector }, ...kept].slice(0, SEMANTIC_CANDIDATES) });
  for (const [stored, entry] of scopes) {
    if (scopes.size <= MAX_MEMORY_SCOPES && entry.expires >= now) break;
    scopes.delete(stored);
  }
}

export async function cacheBackend(): Promise<CacheBackend> {
  if (!redisUrl()) return "memory";
  const redis = await sharedRedis();
  return redis?.status === "ready" ? "redis" : "fallback";
}

export function resetCacheMemory(): void {
  entries.clear();
  scopes.clear();
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
