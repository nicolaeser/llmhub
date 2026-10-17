import "server-only";
import prisma from "@/lib/db/prisma";
import { discoveredOf } from "@/lib/gateway/upstreams/provider-prices";
import type { FactTarget, ModelFacts } from "@/types/routing";

const FACTS_TTL_MS = 60_000;
const FACT_KINDS = new Set(["codex"]);
const factCache = new Map<string, { at: number; models: ReadonlyMap<string, ModelFacts> }>();

export function factsByModel(discovered: unknown): ReadonlyMap<string, ModelFacts> {
  const models = new Map<string, ModelFacts>();
  for (const model of discoveredOf(discovered)) {
    if (!model.serviceTiers && !model.accessPrograms) continue;
    const facts: ModelFacts = {};
    if (model.serviceTiers) facts.serviceTiers = model.serviceTiers;
    if (model.accessPrograms) facts.accessPrograms = model.accessPrograms;
    models.set(model.id, facts);
  }
  return models;
}

export async function attachModelFacts(deployments: FactTarget[]): Promise<void> {
  const providers = [
    ...new Set(deployments.filter((dep) => FACT_KINDS.has(dep.kind) && dep.provider_id).map((dep) => dep.provider_id)),
  ];
  if (!providers.length) return;
  const now = Date.now();
  const stale = providers.filter((id) => (factCache.get(id)?.at ?? -FACTS_TTL_MS) + FACTS_TTL_MS <= now);
  if (stale.length) {
    const rows = await prisma.providerConnection.findMany({
      where: { id: { in: stale } },
      select: { id: true, discovered: true },
    });
    for (const id of stale) {
      factCache.set(id, { at: now, models: factsByModel(rows.find((row) => row.id === id)?.discovered) });
    }
  }
  for (const dep of deployments) {
    const facts = factCache.get(dep.provider_id)?.models.get(dep.model);
    if (facts) dep.facts = facts;
  }
}
