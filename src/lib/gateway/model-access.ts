import "server-only";
import prisma from "@/lib/db/prisma";
import { asStringArray } from "@/lib/gateway/core";
import { modelPolicies, resolveAccess } from "@/lib/gateway/model-policy";
import type { ModelAccess, ModelPolicy, TemplateRules } from "@/types/model-templates";

export const templateRuleSelect = {
  id: true,
  models: true,
  patterns: true,
  providerIds: true,
  regions: true,
  zdrOnly: true,
  noTrainingOnly: true,
  maxRetentionDays: true,
} as const;

export async function loadModelPolicies(): Promise<ModelPolicy[]> {
  const [groups, providers] = await Promise.all([
    prisma.modelGroup.findMany({
      orderBy: { alias: "asc" },
      select: {
        alias: true,
        overflowGroup: true,
        fallbackGroups: true,
        deployments: { select: { providerId: true } },
      },
    }),
    prisma.providerConnection.findMany({
      select: { id: true, zdr: true, retentionDays: true, region: true, noTraining: true },
    }),
  ]);
  return modelPolicies(
    groups.map((group) => ({
      alias: group.alias,
      providerIds: group.deployments.map((deployment) => deployment.providerId),
      overflowGroup: group.overflowGroup,
      fallbackGroups: asStringArray(group.fallbackGroups),
    })),
    providers,
  );
}

export async function modelAccess(explicit: string[], templates: TemplateRules[]): Promise<ModelAccess> {
  if (!templates.length) return { models: explicit, limits: {} };
  return resolveAccess(explicit, templates, await loadModelPolicies());
}
