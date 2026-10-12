import assert from "node:assert/strict";
import test from "node:test";
import { responseCacheColumns } from "@/lib/gateway/billing";
import {
  cacheBackend,
  cacheGet,
  cacheKey,
  cachePut,
  resetCacheMemory,
  semanticAdd,
  semanticFind,
  semanticProbe,
  similarity,
  unitVector,
} from "@/lib/gateway/cache";
import { cachedTokens, embeddingVector, semanticAllowed } from "@/lib/gateway/chat-cache";
import { normalizeEnterprise, normalizeSemanticCache } from "@/lib/gateway/settings";
import { responseCacheStats } from "@/lib/gateway/usage-totals";
import { cacheSettingsSchema, cacheStatsSchema } from "@/schemas/settings";
import type { Principal } from "@/types/gateway";

const entry = (text: string) => ({
  response: { id: "chatcmpl_1", choices: [{ message: { role: "assistant", content: text } }] },
  cost: 0.002,
  tokens: 120,
});

function vector(values: number[]): Float32Array {
  const unit = unitVector(values);
  assert.ok(unit);
  return unit;
}

function chat(last: unknown, system = "You answer billing questions.") {
  return {
    model: "gpt-x",
    temperature: 0,
    messages: [
      { role: "system", content: system },
      { role: "user", content: last },
    ],
  };
}

function principal(models: string[], allowedEndpoints?: string[]): Principal {
  return {
    models,
    key: allowedEndpoints ? { templates: [], allowed_endpoints: allowedEndpoints } : null,
  } as unknown as Principal;
}

test("memory backend is used without REDIS_URL", async () => {
  assert.equal(await cacheBackend(), "memory");
});

test("cache stores responses with their cost and expires them", async () => {
  resetCacheMemory();
  const now = 1_000_000;
  assert.equal(await cachePut("k1", entry("hello"), 60, now), true);
  assert.deepEqual(await cacheGet("k1", now + 59_000), entry("hello"));
  assert.equal(await cacheGet("k1", now + 61_000), null);
  assert.equal(await cacheGet("missing", now), null);
});

test("cache skips a zero TTL and oversized responses", async () => {
  resetCacheMemory();
  assert.equal(await cachePut("zero", entry("x"), 0), false);
  assert.equal(await cacheGet("zero"), null);
  assert.equal(await cachePut("big", entry("x".repeat(600 * 1024)), 60), false);
  assert.equal(await cacheGet("big"), null);
});

test("memory cache evicts the least recently used entry beyond 1000", async () => {
  resetCacheMemory();
  const now = Date.now();
  for (let i = 0; i < 1000; i++) await cachePut(`k${i}`, entry(String(i)), 60, now);
  assert.ok(await cacheGet("k0", now));
  await cachePut("k1000", entry("1000"), 60, now);
  assert.ok(await cacheGet("k0", now));
  assert.equal(await cacheGet("k1", now), null);
  assert.ok(await cacheGet("k1000", now));
});

test("semantic probe compares only the last user message", () => {
  const a = semanticProbe("api", "key1", "gpt-x", "embed", chat("How do I reset my password?"));
  const b = semanticProbe("api", "key1", "gpt-x", "embed", chat("How can I reset my password"));
  assert.ok(a && b);
  assert.equal(a.scope, b.scope);
  assert.equal(a.text, "How do I reset my password?");
  const scopes = [
    semanticProbe("api", "key2", "gpt-x", "embed", chat("How do I reset my password?")),
    semanticProbe("api", "key1", "gpt-y", "embed", chat("How do I reset my password?")),
    semanticProbe("api", "key1", "gpt-x", "embed-2", chat("How do I reset my password?")),
    semanticProbe("api", "key1", "gpt-x", "embed", chat("How do I reset my password?", "You write poems.")),
    semanticProbe("api", "key1", "gpt-x", "embed", { ...chat("How do I reset my password?"), temperature: 1 }),
  ].map((probe) => probe?.scope);
  for (const scope of scopes) {
    assert.ok(scope);
    assert.notEqual(scope, a.scope);
  }
});

test("semantic probe only takes plain user text", () => {
  assert.equal(
    semanticProbe("api", "k", "m", "e", chat([{ type: "text", text: "Hello" }, { type: "text", text: "there" }]))?.text,
    "Hello\nthere",
  );
  assert.equal(
    semanticProbe("api", "k", "m", "e", chat([{ type: "text", text: "What is this?" }, { type: "image_url", image_url: { url: "x" } }])),
    null,
  );
  assert.equal(semanticProbe("api", "k", "m", "e", chat("   ")), null);
  assert.equal(semanticProbe("api", "k", "m", "e", chat("x".repeat(8_001))), null);
  assert.equal(
    semanticProbe("api", "k", "m", "e", { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }] }),
    null,
  );
  assert.equal(semanticProbe("api", "k", "m", "e", { prompt: "hi" }), null);
});

test("vectors are normalized for cosine similarity", () => {
  const a = vector([3, 4]);
  assert.ok(Math.abs(similarity(a, a) - 1) < 1e-6);
  assert.ok(Math.abs(similarity(a, vector([4, -3]))) < 1e-6);
  assert.equal(similarity(a, vector([1, 2, 3])), -1);
  assert.equal(unitVector([0, 0]), null);
  assert.equal(unitVector(["1", 2]), null);
  assert.equal(unitVector([]), null);
});

test("semantic find returns the closest entry above the threshold", async () => {
  resetCacheMemory();
  await semanticAdd("scope", "close", vector([1, 0.1, 0]), 60);
  await semanticAdd("scope", "far", vector([0, 1, 0]), 60);
  const match = await semanticFind("scope", vector([1, 0.05, 0]), 0.95);
  assert.equal(match?.key, "close");
  assert.ok(match && match.similarity > 0.99);
  assert.equal(await semanticFind("scope", vector([0.5, 0.5, 0.7]), 0.95), null);
  assert.equal(await semanticFind("other", vector([1, 0.1, 0]), 0.5), null);
});

test("semantic scopes keep the newest 50 candidates and expire", async () => {
  resetCacheMemory();
  const now = 5_000_000;
  for (let i = 0; i < 51; i++) {
    const angle = (i * Math.PI) / 200;
    await semanticAdd("scope", `k${i}`, vector([Math.cos(angle), Math.sin(angle)]), 60, now);
  }
  assert.equal(await semanticFind("scope", vector([1, 0]), 0.99999, now), null);
  assert.equal((await semanticFind("scope", vector([1, 0]), 0.5, now))?.key, "k1");
  assert.equal(await semanticFind("scope", vector([1, 0]), 0.5, now + 61_000), null);
});

test("embedding responses become unit vectors", () => {
  const parsed = embeddingVector({ data: [{ embedding: [0, 2] }] });
  assert.deepEqual(parsed && Array.from(parsed), [0, 1]);
  assert.equal(embeddingVector({ data: [] }), null);
  assert.equal(embeddingVector({ error: "nope" }), null);
});

test("semantic matching needs a model and endpoint the key may use on the api pool", () => {
  const on = { enabled: true, model: "embed", threshold: 0.95 };
  assert.equal(semanticAllowed("api", principal([]), on), true);
  assert.equal(semanticAllowed("api", principal(["gpt-x", "embed"]), on), true);
  assert.equal(semanticAllowed("api", principal(["gpt-x"]), on), false);
  assert.equal(semanticAllowed("api", principal([]), { ...on, enabled: false }), false);
  assert.equal(semanticAllowed("api", principal([]), { ...on, model: "" }), false);
  assert.equal(semanticAllowed("subscription", principal([]), on), false);
  assert.equal(semanticAllowed("api", principal([], ["chat"]), on), false);
  assert.equal(semanticAllowed("api", principal([], ["chat", "embeddings"]), on), true);
  assert.equal(semanticAllowed("api", principal([], []), on), true);
});

test("response cache keys and semantic scopes are separate per route pool", () => {
  const body = chat("How do I reset my password?");
  assert.notEqual(cacheKey("api", "key1", "gpt-x", "{}"), cacheKey("subscription", "key1", "gpt-x", "{}"));
  assert.notEqual(
    semanticProbe("api", "key1", "gpt-x", "embed", body)?.scope,
    semanticProbe("subscription", "key1", "gpt-x", "embed", body)?.scope,
  );
});

test("cache events map to usage columns", () => {
  assert.deepEqual(responseCacheColumns(undefined, 0.5), {
    responseCacheHits: 0,
    responseCacheSemanticHits: 0,
    responseCacheMisses: 0,
    responseCacheSavedTokens: 0,
    responseCacheSavedCost: 0,
    responseCacheLookupCost: 0,
  });
  assert.deepEqual(responseCacheColumns({ event: "hit", savedTokens: 120, savedCost: 0.002 }, 0), {
    responseCacheHits: 1,
    responseCacheSemanticHits: 0,
    responseCacheMisses: 0,
    responseCacheSavedTokens: 120,
    responseCacheSavedCost: 0.002,
    responseCacheLookupCost: 0,
  });
  assert.equal(responseCacheColumns({ event: "semantic_hit", savedTokens: 5 }, 0).responseCacheSemanticHits, 1);
  assert.equal(responseCacheColumns({ event: "semantic_hit", savedTokens: 5 }, 0).responseCacheHits, 1);
  assert.equal(responseCacheColumns({ event: "miss" }, 0.4).responseCacheMisses, 1);
  assert.equal(responseCacheColumns({ event: "miss" }, 0.4).responseCacheSavedCost, 0);
  assert.equal(responseCacheColumns({ event: "lookup" }, 0.0001).responseCacheLookupCost, 0.0001);
  assert.equal(responseCacheColumns({ event: "lookup", savedCost: 3 }, 0).responseCacheSavedCost, 0);
});

test("cache stats compute hit rate and net savings", () => {
  const stats = responseCacheStats(30, {
    hits: 30,
    semanticHits: 10,
    misses: 70,
    savedTokens: 9000,
    savedCost: 1.5,
    lookupCost: 0.25,
  });
  assert.equal(stats.hitRate, 0.3);
  assert.equal(stats.netSaved, 1.25);
  assert.equal(responseCacheStats(7, { hits: 0, semanticHits: 0, misses: 0, savedTokens: 0, savedCost: 0, lookupCost: 0 }).hitRate, 0);
});

test("cached tokens count prompt and completion", () => {
  assert.equal(cachedTokens({ prompt_tokens: 100, completion_tokens: 20 }), 120);
  assert.equal(cachedTokens({}), 0);
});

test("semantic settings are normalized", () => {
  assert.deepEqual(normalizeSemanticCache(undefined), { enabled: false, model: "", threshold: 0.95 });
  assert.deepEqual(normalizeSemanticCache({ enabled: true, model: "", threshold: 0.9 }), {
    enabled: false,
    model: "",
    threshold: 0.9,
  });
  assert.equal(normalizeSemanticCache({ threshold: 0.2 }).threshold, 0.8);
  assert.equal(normalizeSemanticCache({ threshold: 4 }).threshold, 1);
  assert.equal(normalizeSemanticCache({ enabled: true, model: "Text-Embed" }).enabled, true);
  assert.deepEqual(normalizeEnterprise({}).cache_semantic, { enabled: false, model: "", threshold: 0.95 });
});

test("cache settings input is validated", () => {
  assert.equal(cacheSettingsSchema.safeParse({ cacheTtlSeconds: 300 }).success, true);
  assert.equal(cacheSettingsSchema.safeParse({ cacheTtlSeconds: -1 }).success, false);
  assert.equal(cacheSettingsSchema.safeParse({ cacheTtlSeconds: 86_400 * 31 }).success, false);
  assert.equal(cacheSettingsSchema.safeParse({ cacheTtlSeconds: 1.5 }).success, false);
  const semantic = { enabled: true, model: "embed", threshold: 0.95 };
  assert.equal(cacheSettingsSchema.safeParse({ semantic }).success, true);
  assert.equal(cacheSettingsSchema.safeParse({ semantic: { ...semantic, model: "" } }).success, false);
  assert.equal(cacheSettingsSchema.safeParse({ semantic: { ...semantic, threshold: 0.5 } }).success, false);
  assert.equal(cacheStatsSchema.safeParse({ days: 30 }).success, true);
  assert.equal(cacheStatsSchema.safeParse({ days: 31 }).success, false);
});
