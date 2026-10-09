import "server-only";
import prisma from "@/lib/db/prisma";
import { GateError } from "@/lib/gateway/errors";
import { modelPermitted } from "@/lib/gateway/gate";
import { attributesOf, matchesFilter } from "@/lib/rag/filters";
import { fileIndexes } from "@/lib/rag/index-cache";
import { queryTerms } from "@/lib/rag/lexical";
import { embedTexts, rerankTexts } from "@/lib/rag/models";
import { scoreFiles } from "@/lib/rag/rank";
import { touchStores, vectorDefaults } from "@/lib/rag/stores";
import type { Principal } from "@/types/gateway";
import type { IndexedFile, SearchableStore, SearchHit, SearchRequest } from "@/types/rag";

const RERANK_POOL = 50;
const MIN_RERANK_POOL = 20;

type Candidate = { storeId: string; file: IndexedFile; slot: number; score: number };

function candidateKey(candidate: Candidate): string {
  return candidate.file.index.ids[candidate.slot]!;
}

async function indexedFiles(store: SearchableStore, request: SearchRequest): Promise<IndexedFile[]> {
  const rows = await prisma.vectorStoreFile.findMany({
    where: { storeId: store.id, status: "completed" },
    select: { fileId: true, filename: true, attributes: true, indexedAt: true },
  });
  const allowed = rows
    .map((row) => ({ ...row, attributes: attributesOf(row.attributes) }))
    .filter((row) => matchesFilter(row.attributes, request.filters));
  if (!allowed.length || !store.dimensions) return [];
  const indexes = await fileIndexes(
    store.id,
    store.dimensions,
    allowed.map((row) => ({ fileId: row.fileId, stamp: row.indexedAt?.getTime() ?? 0 })),
  );
  return allowed.flatMap((row) => {
    const index = indexes.get(row.fileId);
    return index ? [{ fileId: row.fileId, filename: row.filename, attributes: row.attributes, index }] : [];
  });
}

async function queryVectors(
  principal: Principal,
  endpoint: string,
  stores: SearchableStore[],
  queries: string[],
): Promise<Map<string, Float32Array[]>> {
  const groups = new Map<string, SearchableStore[]>();
  for (const store of stores) {
    const key = `${store.embeddingModel}\u0000${store.embeddingDimensions}`;
    groups.set(key, [...(groups.get(key) ?? []), store]);
  }
  const out = new Map<string, Float32Array[]>();
  for (const members of groups.values()) {
    const first = members[0]!;
    const vectors = await embedTexts({
      principal,
      endpoint,
      model: first.embeddingModel,
      dimensions: first.embeddingDimensions,
      texts: queries,
    });
    for (const store of members) {
      const dims = vectors[0]?.length ?? 0;
      if (store.dimensions && dims !== store.dimensions) {
        throw new GateError(
          400,
          "invalid_request",
          `embedding model ${store.embeddingModel} now returns ${dims} dimensions but vector store ${store.id} holds ${store.dimensions}`,
          { param: "vector_store_id" },
        );
      }
      out.set(store.id, vectors);
    }
  }
  return out;
}

async function rerankModel(principal: Principal, stores: SearchableStore[], request: SearchRequest): Promise<string> {
  if (request.ranking.ranker === "none") return "";
  if (request.rerankModel !== null) return request.rerankModel;
  const configured = stores.find((store) => store.rerankModel)?.rerankModel || (await vectorDefaults()).rerank_model;
  return configured && modelPermitted(principal, configured) ? configured : "";
}

async function chunkTexts(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await prisma.vectorChunk.findMany({ where: { id: { in: ids } }, select: { id: true, text: true } });
  return new Map(rows.map((row) => [row.id, row.text]));
}

export async function searchStores(input: {
  principal: Principal;
  endpoint: string;
  stores: SearchableStore[];
  request: SearchRequest;
}): Promise<SearchHit[]> {
  const { principal, request } = input;
  const files = new Map<string, IndexedFile[]>();
  for (const store of input.stores) files.set(store.id, await indexedFiles(store, request));
  const searchable = input.stores.filter((store) => files.get(store.id)?.length);
  if (!searchable.length) {
    void touchStores(input.stores).catch(() => undefined);
    return [];
  }
  const vectors = await queryVectors(principal, input.endpoint, searchable, request.queries);
  const terms = queryTerms(request.queries);
  const best = new Map<string, Candidate>();
  for (const store of searchable) {
    const storeVectors = vectors.get(store.id) ?? [];
    for (const query of storeVectors) {
      for (const scored of scoreFiles(files.get(store.id) ?? [], query, terms, request.ranking)) {
        const candidate: Candidate = { storeId: store.id, ...scored };
        const key = candidateKey(candidate);
        const seen = best.get(key);
        if (!seen || seen.score < candidate.score) best.set(key, candidate);
      }
    }
  }
  let ranked = [...best.values()].sort((a, b) => b.score - a.score);
  const reranker = await rerankModel(principal, searchable, request);
  const texts = new Map<string, string>();
  if (reranker && ranked.length) {
    const pool = ranked.slice(0, Math.min(RERANK_POOL, Math.max(MIN_RERANK_POOL, request.maxResults * 3)));
    const loaded = await chunkTexts(pool.map(candidateKey));
    for (const [id, text] of loaded) texts.set(id, text);
    const results = await rerankTexts({
      principal,
      endpoint: input.endpoint,
      model: reranker,
      query: request.queries.join("\n"),
      documents: pool.map((candidate) => texts.get(candidateKey(candidate)) ?? ""),
    });
    ranked = results
      .filter((result) => result.index >= 0 && result.index < pool.length)
      .map((result) => ({ ...pool[result.index]!, score: result.score }))
      .sort((a, b) => b.score - a.score);
  }
  const top = ranked.filter((candidate) => candidate.score >= request.ranking.scoreThreshold).slice(0, request.maxResults);
  const missing = top.map(candidateKey).filter((id) => !texts.has(id));
  for (const [id, text] of await chunkTexts(missing)) texts.set(id, text);
  void touchStores(input.stores).catch(() => undefined);
  return top.map((candidate) => {
    const chunkId = candidateKey(candidate);
    return {
      storeId: candidate.storeId,
      fileId: candidate.file.fileId,
      filename: candidate.file.filename,
      chunkId,
      position: candidate.file.index.positions[candidate.slot] ?? 0,
      score: candidate.score,
      attributes: candidate.file.attributes,
      text: texts.get(chunkId) ?? "",
    };
  });
}

export function hitJson(hit: SearchHit) {
  return {
    file_id: hit.fileId,
    filename: hit.filename,
    score: hit.score,
    attributes: hit.attributes,
    content: [{ type: "text", text: hit.text }],
  };
}
