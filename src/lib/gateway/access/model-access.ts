import "server-only";
import prisma from "@/lib/db/prisma";
import { asStringArray } from "@/lib/gateway/core";
import { modelPolicies, resolveAccess } from "@/lib/gateway/access/model-policy";
import { hiddenFrom, routePool } from "@/lib/gateway/routing/route-pool";
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
        deployments: { select: { kind: true, providerId: true, provider: { select: { kind: true, internal: true } } } },
      },
    }),
    prisma.providerConnection.findMany({
      where: { internal: false },
      select: { id: true, zdr: true, retentionDays: true, region: true, noTraining: true },
    }),
  ]);
  return modelPolicies(
    groups
      .filter((group) => !hiddenFrom("api", group.deployments))
      .map((group) => ({
        alias: group.alias,
        providerIds: group.deployments
          .filter((deployment) => routePool(deployment) !== "internal")
          .map((deployment) => deployment.providerId),
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
