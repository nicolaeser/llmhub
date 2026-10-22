import { z } from "zod";
import { modelAlias } from "@/lib/gateway/catalog/model-alias";
import type { FeatureModelRole, ModelFeature } from "@/types/models";

export const MODEL_FEATURES = ["mcp_builder", "catalog", "cache", "knowledge", "pii"] as const satisfies readonly ModelFeature[];

export const FEATURE_MODEL_ROLES = ["chat", "jev", "embedding", "ocr", "rerank", "redaction"] as const satisfies readonly FeatureModelRole[];

export const featureModelTestSchema = z.object({
  feature: z.enum(MODEL_FEATURES),
  role: z.enum(FEATURE_MODEL_ROLES),
  model: z.string().trim().max(200).transform(modelAlias).default(""),
});
