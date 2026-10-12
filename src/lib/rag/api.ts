import "server-only";
import { asStringMap, ownerId } from "@/lib/gateway/core";
import { GateError } from "@/lib/gateway/errors";
import { allowModel, readBody } from "@/lib/gateway/gate";
import { parseRequest } from "@/lib/gateway/responses";
import { chunkSettings } from "@/lib/rag/chunking";
import { kickIngest } from "@/lib/rag/ingest";
import { rankingOptions } from "@/lib/rag/rank";
import { storeOwner } from "@/lib/rag/scope";
import {
  attachFiles,
  createVectorStore,
  deleteVectorStore,
  ingestSnapshot,
  storesJson,
  vectorDefaults,
  type AttachRequest,
  type StoreRow,
} from "@/lib/rag/stores";
import type { ZodType, z } from "zod";
import type {
  attachFileSchema,
  createVectorStoreSchema,
  fileBatchSchema,
  searchVectorStoreSchema,
} from "@/schemas/rag";
import type { JsonMap, Principal } from "@/types/gateway";
import type { SearchRequest, SearchableStore } from "@/types/rag";

export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  const parsed = parseRequest(schema, await readBody(req));
  if (!parsed.ok) throw new GateError(400, "invalid_request", parsed.message, { param: parsed.param });
  return parsed.data;
}

export function searchableStore(row: StoreRow): SearchableStore {
  return {
    id: row.id,
    embeddingModel: row.embeddingModel,
    embeddingDimensions: row.embeddingDimensions,
    dimensions: row.dimensions,
    rerankModel: row.rerankModel,
    expiresAfterDays: row.expiresAfterDays,
  };
}

export function searchRequest(body: z.infer<typeof searchVectorStoreSchema>): SearchRequest {
  if (body.rewrite_query) {
    throw new GateError(400, "unsupported_parameter", "rewrite_query is not supported", { param: "rewrite_query" });
  }
  return {
    queries: typeof body.query === "string" ? [body.query] : body.query,
    filters: body.filters ?? null,
    maxResults: body.max_num_results ?? 10,
    ranking: rankingOptions(body.ranking_options),
    rerankModel: body.rerank_model === undefined ? null : (body.rerank_model ?? ""),
  };
}

export async function createStoreFor(
  principal: Principal,
  body: z.infer<typeof createVectorStoreSchema>,
): Promise<JsonMap> {
  const defaults = await vectorDefaults();
  const embeddingModel = body.embedding_model || defaults.embedding_model;
  if (!embeddingModel) {
    throw new GateError(
      400,
      "missing_required_parameter",
      "embedding_model is required because no default embedding model is configured",
      { param: "embedding_model" },
    );
  }
  for (const model of [embeddingModel, body.rerank_model, body.ocr_model]) if (model) allowModel(principal, model);
  const chunk = chunkSettings(body.chunking_strategy);
  const store = await createVectorStore({
    owner: storeOwner(principal),
    createdBy: principal.key?.token_id || principal.userId,
    name: body.name ?? "",
    description: body.description ?? "",
    embeddingModel,
    embeddingDimensions: body.embedding_dimensions ?? (body.embedding_model ? 0 : defaults.embedding_dimensions),
    rerankModel: body.rerank_model ?? "",
    ocrModel: body.ocr_model ?? "",
    chunk,
    metadata: asStringMap(body.metadata),
    expiresAfterDays: body.expires_after?.days ?? null,
  });
  if (body.file_ids?.length) {
    try {
      await attachFor(principal, store, body.file_ids.map((fileId) => ({ fileId, chunk, attributes: {} })), "");
    } catch (err) {
      await deleteVectorStore(store.id);
      throw err;
    }
  }
  return (await storesJson([store]))[0]!;
}

export async function attachFor(principal: Principal, store: StoreRow, files: AttachRequest[], batchId: string) {
  const rows = await attachFiles({
    store,
    fileOwner: ownerId(principal),
    snapshot: ingestSnapshot(principal),
    files,
    batchId,
  });
  kickIngest();
  return rows;
}

export function attachRequest(store: StoreRow, body: z.infer<typeof attachFileSchema>): AttachRequest {
  return {
    fileId: body.file_id,
    chunk: chunkSettings(body.chunking_strategy, {
      maxTokens: store.chunkMaxTokens,
      overlapTokens: store.chunkOverlapTokens,
    }),
    attributes: body.attributes ?? {},
  };
}

export function batchRequests(store: StoreRow, body: z.infer<typeof fileBatchSchema>): AttachRequest[] {
  const shared = { chunking_strategy: body.chunking_strategy, attributes: body.attributes };
  const files = body.files?.length
    ? body.files.map((file) => ({
        file_id: file.file_id,
        chunking_strategy: file.chunking_strategy ?? shared.chunking_strategy,
        attributes: file.attributes ?? shared.attributes,
      }))
    : (body.file_ids ?? []).map((file_id) => ({ file_id, ...shared }));
  return files.map((file) => attachRequest(store, file));
}
