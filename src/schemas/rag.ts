import { z } from "zod";
import { modelAlias } from "@/lib/gateway/model-alias";
import type { AttributeFilter } from "@/types/rag";

export const MAX_STORE_KEYS = 16;
export const MAX_BATCH_FILES = 500;
export const MIN_CHUNK_TOKENS = 100;
export const MAX_CHUNK_TOKENS = 4096;

const alias = z.string().trim().max(200).transform(modelAlias);

const limitedKeys = <T extends z.ZodType>(value: T) =>
  z
    .record(z.string().min(1).max(64), value)
    .refine((record) => Object.keys(record).length <= MAX_STORE_KEYS, {
      message: `at most ${MAX_STORE_KEYS} keys are allowed`,
    });

export const metadataSchema = limitedKeys(z.string().max(512));

const attributeValueSchema = z.union([z.string().max(512), z.number(), z.boolean()]);

export const attributesSchema = limitedKeys(attributeValueSchema);

export const chunkingStrategySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auto") }),
  z.object({
    type: z.literal("static"),
    static: z
      .object({
        max_chunk_size_tokens: z.number().int().min(MIN_CHUNK_TOKENS).max(MAX_CHUNK_TOKENS),
        chunk_overlap_tokens: z.number().int().min(0),
      })
      .refine((value) => value.chunk_overlap_tokens <= value.max_chunk_size_tokens / 2, {
        message: "chunk_overlap_tokens must not exceed half of max_chunk_size_tokens",
        path: ["chunk_overlap_tokens"],
      }),
  }),
]);

const expiresAfterSchema = z.object({
  anchor: z.literal("last_active_at"),
  days: z.number().int().min(1).max(365),
});

export const createVectorStoreSchema = z.looseObject({
  name: z.string().max(256).nullish(),
  description: z.string().max(512).nullish(),
  file_ids: z.array(z.string().min(1)).max(MAX_BATCH_FILES).nullish(),
  chunking_strategy: chunkingStrategySchema.nullish(),
  expires_after: expiresAfterSchema.nullish(),
  metadata: metadataSchema.nullish(),
  embedding_model: alias.nullish(),
  embedding_dimensions: z.number().int().min(1).max(8192).nullish(),
  rerank_model: alias.nullish(),
  ocr_model: alias.nullish(),
});

export const updateVectorStoreSchema = z.looseObject({
  name: z.string().max(256).nullish(),
  description: z.string().max(512).nullish(),
  expires_after: expiresAfterSchema.nullable().optional(),
  metadata: metadataSchema.nullish(),
  rerank_model: alias.nullish(),
  ocr_model: alias.nullish(),
});

export const attachFileSchema = z.looseObject({
  file_id: z.string().min(1),
  chunking_strategy: chunkingStrategySchema.nullish(),
  attributes: attributesSchema.nullish(),
});

export const fileBatchSchema = z
  .looseObject({
    file_ids: z.array(z.string().min(1)).max(MAX_BATCH_FILES).nullish(),
    files: z
      .array(
        z.looseObject({
          file_id: z.string().min(1),
          chunking_strategy: chunkingStrategySchema.nullish(),
          attributes: attributesSchema.nullish(),
        }),
      )
      .max(MAX_BATCH_FILES)
      .nullish(),
    chunking_strategy: chunkingStrategySchema.nullish(),
    attributes: attributesSchema.nullish(),
  })
  .refine((body) => Boolean(body.file_ids?.length) !== Boolean(body.files?.length), {
    message: "provide either file_ids or files",
    path: ["file_ids"],
  });

export const updateFileSchema = z.looseObject({
  attributes: attributesSchema.nullable(),
});

const comparisonSchema = z.object({
  type: z.enum(["eq", "ne", "gt", "gte", "lt", "lte", "in", "nin"]),
  key: z.string().min(1).max(64),
  value: z.union([attributeValueSchema, z.array(attributeValueSchema).max(100)]),
});

export const attributeFilterSchema: z.ZodType<AttributeFilter> = z.lazy(() =>
  z.union([
    comparisonSchema,
    z.object({
      type: z.enum(["and", "or"]),
      filters: z.array(attributeFilterSchema).min(1).max(20),
    }),
  ]),
);

export const rankingOptionsSchema = z.looseObject({
  ranker: z.enum(["none", "auto", "default-2024-11-15", "default-2024-08-21"]).nullish(),
  score_threshold: z.number().min(0).max(1).nullish(),
  hybrid_search: z
    .looseObject({
      embedding_weight: z.number().min(0).max(100),
      text_weight: z.number().min(0).max(100),
    })
    .refine((weights) => weights.embedding_weight + weights.text_weight > 0, {
      message: "embedding_weight and text_weight must not both be 0",
    })
    .nullish(),
});

const queryText = z.string().trim().min(1).max(4096);

export const searchVectorStoreSchema = z.looseObject({
  query: z.union([queryText, z.array(queryText).min(1).max(10)]),
  filters: attributeFilterSchema.nullish(),
  max_num_results: z.number().int().min(1).max(50).nullish(),
  ranking_options: rankingOptionsSchema.nullish(),
  rewrite_query: z.boolean().nullish(),
  rerank_model: alias.nullable().optional(),
});

export const fileSearchToolSchema = z.looseObject({
  type: z.literal("file_search"),
  vector_store_ids: z.array(z.string().min(1)).min(1).max(10),
  max_num_results: z.number().int().min(1).max(50).nullish(),
  filters: attributeFilterSchema.nullish(),
  ranking_options: rankingOptionsSchema.nullish(),
});

export const rerankRequestSchema = z.looseObject({
  model: z.string().min(1),
  query: z.string().min(1),
  documents: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).min(1).max(1000),
  top_n: z.number().int().min(1).nullish(),
  return_documents: z.boolean().nullish(),
});

export const vectorDefaultsSchema = z.object({
  embedding_model: alias,
  embedding_dimensions: z.number().int().min(0).max(8192),
  ocr_model: alias,
  rerank_model: alias,
});

export const companyStoreSchema = z.object({
  orgId: z.string().min(1),
  projectId: z.string().min(1).nullable(),
  name: z.string().trim().min(1).max(256),
  description: z.string().trim().max(512),
  embeddingModel: alias,
  embeddingDimensions: z.number().int().min(0).max(8192),
  rerankModel: alias,
  ocrModel: alias,
  chunkMaxTokens: z.number().int().min(MIN_CHUNK_TOKENS).max(MAX_CHUNK_TOKENS),
  chunkOverlapTokens: z.number().int().min(0),
  expiresAfterDays: z.number().int().min(1).max(365).nullable(),
}).refine((value) => value.chunkOverlapTokens <= value.chunkMaxTokens / 2, {
  message: "overlap must not exceed half of the chunk size",
  path: ["chunkOverlapTokens"],
});

export const updateCompanyStoreSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(256),
  description: z.string().trim().max(512),
  rerankModel: alias,
  ocrModel: alias,
  expiresAfterDays: z.number().int().min(1).max(365).nullable(),
});
