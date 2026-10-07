import "server-only";
import prisma from "@/lib/db/prisma";
import type { z } from "zod";
import type { modelAliasCreateSchema } from "@/schemas/management";
import type { DeploymentInput, PriceWindow } from "@/types/models";

export function priceWindowInputs(
  schedule: z.infer<typeof modelAliasCreateSchema>["price_schedule"] | undefined,
): PriceWindow[] | undefined {
  return schedule?.map((window) => ({
    start: window.start,
    end: window.end,
    priceInput: window.price_input_per_1k,
    priceOutput: window.price_output_per_1k,
  }));
}

export async function deploymentInputs(
  deployments: z.infer<typeof modelAliasCreateSchema>["deployments"],
): Promise<DeploymentInput[]> {
  const ids = [...new Set(deployments.map((dep) => dep.provider_id).filter((id): id is string => Boolean(id)))];
  const providers = ids.length
    ? await prisma.providerConnection.findMany({ where: { id: { in: ids } }, select: { id: true, kind: true } })
    : [];
  const kinds = new Map(providers.map((row) => [row.id, row.kind]));
  return deployments.map((dep) => ({
    ...(dep.id ? { id: dep.id } : {}),
    kind: dep.kind ?? (dep.provider_id ? kinds.get(dep.provider_id) : undefined) ?? "openai_compat",
    baseUrl: dep.base_url,
    model: dep.model,
    weight: dep.weight,
    costInput: dep.cost_input_per_1k,
    costOutput: dep.cost_output_per_1k,
    providerId: dep.provider_id ?? null,
  }));
}
