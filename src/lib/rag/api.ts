import "server-only";
import { asStringMap, ERR_UNKNOWN_GROUP, ownerId } from "@/lib/gateway/core";
import { GateError } from "@/lib/gateway/errors";
import { allowModel, readBody } from "@/lib/gateway/access/gate";
import { hiddenFrom, outsidePool, routable } from "@/lib/gateway/routing/route-pool";
import { loadGroup } from "@/lib/gateway/routing/runtime";
import { parseRequest } from "@/lib/gateway/protocols/parse-request";
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
} from "@/lib/rag/stores";
import type { ZodType, z } from "zod";
import type {
  attachFileSchema,
  createVectorStoreSchema,
  fileBatchSchema,
  searchVectorStoreSchema,
} from "@/schemas/rag";
import type { JsonMap, Principal } from "@/types/gateway";
import type { FileAttachRequest, SearchRequest, SearchableStore, VectorStoreRow } from "@/types/rag";

export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  const parsed = parseRequest(schema, await readBody(req));
  if (!parsed.ok) throw new GateError(400, "invalid_request", parsed.message, { param: parsed.param });
  return parsed.data;
}

export function searchableStore(row: VectorStoreRow): SearchableStore {
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

async function assertApiRoutable(model: string, param: string): Promise<void> {
  const unknown = new GateError(404, "model_not_found", "no deployment for model", { param });
  const group = await loadGroup(model).catch((err: unknown) => {
    if (err === ERR_UNKNOWN_GROUP) throw unknown;
    throw err;
  });
  if (hiddenFrom("api", group.mapped)) throw unknown;
  if (group.mapped.length && !group.mapped.some(routable("api")) && !group.overflow_group) {
    throw new GateError(404, "model_not_found", outsidePool("api").message, { param });
  }
}

export async function allowCallerModels(
  principal: Principal,
  models: Partial<Record<"embedding_model" | "rerank_model" | "ocr_model", string | null>>,
): Promise<void> {
  for (const [param, model] of Object.entries(models)) {
    if (!model) continue;
    allowModel(principal, model);
    await assertApiRoutable(model, param);
  }
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
  await allowCallerModels(principal, {
    embedding_model: body.embedding_model,
    rerank_model: body.rerank_model,
    ocr_model: body.ocr_model,
  });
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

export async function attachFor(principal: Principal, store: VectorStoreRow, files: FileAttachRequest[], batchId: string) {
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

export function attachRequest(store: VectorStoreRow, body: z.infer<typeof attachFileSchema>): FileAttachRequest {
  return {
    fileId: body.file_id,
    chunk: chunkSettings(body.chunking_strategy, {
      maxTokens: store.chunkMaxTokens,
      overlapTokens: store.chunkOverlapTokens,
    }),
    attributes: body.attributes ?? {},
  };
}

export function batchRequests(store: VectorStoreRow, body: z.infer<typeof fileBatchSchema>): FileAttachRequest[] {
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
