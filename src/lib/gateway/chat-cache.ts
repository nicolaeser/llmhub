import "server-only";
import { recordUsage, usageFromUnknown } from "@/lib/gateway/billing";
import { cacheGet, cacheKey, cachePut, semanticAdd, semanticFind, semanticProbe, unitVector } from "@/lib/gateway/cache";
import { asRecord, ownerId } from "@/lib/gateway/core";
import { GateError } from "@/lib/gateway/errors";
import { modelChain, modelPermitted, spendTag, withTrace } from "@/lib/gateway/gate";
import { endpointAllowed } from "@/lib/gateway/key-restrictions";
import { forwardToModel } from "@/lib/gateway/upstream";
import { logger } from "@/lib/logging/logger";
import type { CachedResponse, ChatCacheLookup, ChatCacheSlot, SemanticCacheSettings } from "@/types/cache";
import type { JsonMap, Principal, RoutePool, Usage } from "@/types/gateway";

const EMBEDDINGS_ENDPOINT = "/v1/embeddings";

export function embeddingVector(json: unknown): Float32Array | null {
  const data = asRecord(json)?.data;
  return Array.isArray(data) ? unitVector(asRecord(data[0])?.embedding) : null;
}

export function semanticAllowed(pool: RoutePool, principal: Principal, semantic: SemanticCacheSettings): boolean {
  return (
    pool === "api" &&
    semantic.enabled &&
    Boolean(semantic.model) &&
    modelPermitted(principal, semantic.model) &&
    endpointAllowed(principal.key?.allowed_endpoints ?? [], EMBEDDINGS_ENDPOINT)
  );
}

async function embedPrompt(principal: Principal, model: string, text: string, tag: string): Promise<Float32Array | null> {
  const body: JsonMap = { model, input: text };
  let aliases: string[];
  try {
    aliases = modelChain(principal, model, body);
  } catch {
    return null;
  }
  const traced = withTrace(principal, EMBEDDINGS_ENDPOINT);
  const started = Date.now();
  const hit = await forwardToModel(aliases, principal.routeLimits, "/embeddings", body).catch(async (err) => {
    await recordUsage({
      principal: traced,
      model,
      status: err instanceof GateError ? err.status : 502,
      outcome: "error",
      latencyMs: Date.now() - started,
      tag,
      request: body,
      error: err,
    }).catch(() => undefined);
    logger.warn("cache.semantic_embedding_failed", { model, err: err instanceof Error ? err.message : String(err) });
    return null;
  });
  if (!hit) return null;
  await recordUsage({
    principal: traced,
    model,
    deployment: hit.dep,
    group: hit.group,
    usage: usageFromUnknown(asRecord(hit.json)?.usage, hit.json),
    status: hit.status,
    outcome: "ok",
    latencyMs: Date.now() - started,
    tag,
    request: body,
    response: hit.json,
    responseCache: { event: "lookup" },
  });
  return embeddingVector(hit.json);
}

export async function lookupChatCache(input: {
  pool: RoutePool;
  principal: Principal;
  model: string;
  body: JsonMap;
  ttlSeconds: number;
  semantic: SemanticCacheSettings;
}): Promise<ChatCacheLookup> {
  const owner = ownerId(input.principal);
  const slot: ChatCacheSlot = {
    key: cacheKey(input.pool, owner, input.model, JSON.stringify(input.body)),
    ttlSeconds: input.ttlSeconds,
    semantic: null,
  };
  const exact = await cacheGet(slot.key);
  if (exact) return { slot, hit: { entry: exact, similarity: null } };
  if (!semanticAllowed(input.pool, input.principal, input.semantic)) return { slot, hit: null };
  const probe = semanticProbe(input.pool, owner, input.model, input.semantic.model, input.body);
  if (!probe) return { slot, hit: null };
  const vector = await embedPrompt(input.principal, input.semantic.model, probe.text, spendTag(input.body));
  if (!vector) return { slot, hit: null };
  const withVector: ChatCacheSlot = { ...slot, semantic: { scope: probe.scope, vector } };
  const match = await semanticFind(probe.scope, vector, input.semantic.threshold);
  const entry = match ? await cacheGet(match.key) : null;
  return {
    slot: withVector,
    hit: match && entry ? { entry, similarity: match.similarity } : null,
  };
}

export function cachedTokens(usage: Partial<Usage>): number {
  return (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
}

export async function storeChatCache(slot: ChatCacheSlot, entry: CachedResponse): Promise<void> {
  const stored = await cachePut(slot.key, entry, slot.ttlSeconds);
  if (stored && slot.semantic) {
    await semanticAdd(slot.semantic.scope, slot.key, slot.semantic.vector, slot.ttlSeconds);
  }
}
