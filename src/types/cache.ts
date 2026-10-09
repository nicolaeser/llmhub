import type { z } from "zod";
import type { CACHE_STATS_RANGES } from "@/lib/gateway/cache-settings";
import type { cacheSettingsSchema } from "@/schemas/settings";
import type { JsonMap } from "@/types/gateway";

export type CachedResponse = { response: JsonMap; cost: number; tokens: number };

export type ResponseCacheEvent = "hit" | "semantic_hit" | "miss" | "lookup";

export type ResponseCacheUsage = { event: ResponseCacheEvent; savedTokens?: number; savedCost?: number };

export type ResponseCacheColumns = {
  responseCacheHits: number;
  responseCacheSemanticHits: number;
  responseCacheMisses: number;
  responseCacheSavedTokens: number;
  responseCacheSavedCost: number;
  responseCacheLookupCost: number;
};

export type SemanticCacheSettings = { enabled: boolean; model: string; threshold: number };

export type SemanticProbe = { scope: string; text: string };

export type SemanticMatch = { key: string; similarity: number };

export type ChatCacheSlot = {
  key: string;
  ttlSeconds: number;
  semantic: { scope: string; vector: Float32Array } | null;
};

export type ChatCacheLookup = {
  slot: ChatCacheSlot;
  hit: { entry: CachedResponse; similarity: number | null } | null;
};

export type CacheBackend = "redis" | "memory" | "fallback";

export type ResponseCacheStatsRange = (typeof CACHE_STATS_RANGES)[number];

export type ResponseCacheStats = {
  days: number;
  hits: number;
  semanticHits: number;
  misses: number;
  hitRate: number;
  savedTokens: number;
  savedCost: number;
  lookupCost: number;
  netSaved: number;
};

export type CacheView = {
  cacheTtlSeconds: number;
  semantic: SemanticCacheSettings;
  backend: CacheBackend;
  aliases: string[];
  stats: ResponseCacheStats | null;
  canManage: boolean;
};

export type CacheSettingsInput = z.input<typeof cacheSettingsSchema>;
