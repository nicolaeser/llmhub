import "server-only";

import prisma from "@/lib/db/prisma";
import { modelAlias } from "@/lib/gateway/catalog/model-alias";
import { DEFAULT_JEV_MODEL } from "@/lib/gateway/catalog/model-catalog";
import { getEnterprise, normalizeSemanticCache, normalizeVectorDefaults } from "@/lib/settings/enterprise";
import { BUILDER_MODEL_KEY } from "@/schemas/mcp";
import type { ModelRole } from "@/lib/models/model-role";
import type { FeatureModelRole, ModelFeature } from "@/types/models";

type SettingReader = () => Promise<string>;

async function vectorDefault(field: "embedding_model" | "ocr_model" | "rerank_model"): Promise<string> {
  return normalizeVectorDefaults((await getEnterprise()).vector_stores)[field];
}

export const FEATURE_MODELS: Record<ModelFeature, Partial<Record<FeatureModelRole, SettingReader>>> = {
  mcp_builder: {
    chat: async () => (await prisma.setting.findUnique({ where: { key: BUILDER_MODEL_KEY } }))?.value ?? "",
  },
  catalog: {
    jev: async () => (await getEnterprise()).catalog_jev?.model || DEFAULT_JEV_MODEL,
  },
  cache: {
    embedding: async () => normalizeSemanticCache((await getEnterprise()).cache_semantic).model,
  },
  knowledge: {
    embedding: () => vectorDefault("embedding_model"),
    ocr: () => vectorDefault("ocr_model"),
    rerank: () => vectorDefault("rerank_model"),
  },
};

export const ROLE_KIND: Record<FeatureModelRole, ModelRole> = {
  chat: "chat",
  jev: "chat",
  embedding: "embedding",
  ocr: "ocr",
  rerank: "rerank",
};

export function featureRoles(feature: ModelFeature): FeatureModelRole[] {
  return (Object.keys(FEATURE_MODELS[feature]) as FeatureModelRole[]).filter((role) => FEATURE_MODELS[feature][role]);
}

export async function featureModel(feature: ModelFeature, role: FeatureModelRole): Promise<string> {
  const read = FEATURE_MODELS[feature][role];
  return read ? modelAlias(await read()) : "";
}
