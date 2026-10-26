import "server-only";
import prisma from "@/lib/db/prisma";
import { newModelMode, planCatalog } from "@/lib/gateway/catalog/model-catalog";
import { discoveredOf } from "@/lib/gateway/upstreams/provider-prices";
import type { CatalogEntryPlan } from "@/types/model-catalog";

export const storedSelect = {
  providerId: true,
  upstreamId: true,
  name: true,
  vendor: true,
  alias: true,
  source: true,
  confidence: true,
  disabled: true,
  classifiedAt: true,
  updatedAt: true,
} as const;

export type StoredRow = {
  providerId: string;
  upstreamId: string;
  name: string;
  vendor: string;
  alias: string;
  source: string;
  confidence: number;
  disabled: boolean;
  classifiedAt: Date | null;
  updatedAt: Date;
};

export function entryKey(row: { providerId: string; upstreamId: string }): string {
  return `${row.providerId}\u0000${row.upstreamId}`;
}

export async function catalogInputs() {
  const [providers, groups, deployments, stored] = await Promise.all([
    prisma.providerConnection.findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, kind: true, internal: true, newModels: true, discovered: true },
    }),
    prisma.modelGroup.findMany({
      orderBy: { alias: "asc" },
      select: { alias: true, vendor: true, displayName: true, autoRoutes: true },
    }),
    prisma.deployment.findMany({ select: { providerId: true, model: true, groupAlias: true } }),
    prisma.catalogEntry.findMany({ select: storedSelect }),
  ]);
  const discovered = new Map(providers.map((provider) => [provider.id, discoveredOf(provider.discovered)]));
  const plan = planCatalog({
    providers: providers.map((provider) => ({
      id: provider.id,
      kind: provider.kind,
      newModels: newModelMode(provider.newModels),
      models: (discovered.get(provider.id) ?? []).map((model) => ({ id: model.id, name: model.name })),
    })),
    groups,
    routes: deployments.flatMap((dep) =>
      dep.providerId ? [{ providerId: dep.providerId, model: dep.model, groupAlias: dep.groupAlias }] : [],
    ),
    stored,
  });
  return { providers, groups, stored, discovered, plan };
}

function changed(prior: StoredRow, entry: CatalogEntryPlan): boolean {
  return (
    prior.name !== entry.name ||
    prior.vendor !== entry.vendor ||
    prior.alias !== entry.alias ||
    prior.source !== entry.source ||
    prior.confidence !== entry.confidence ||
    (prior.classifiedAt?.getTime() ?? null) !== (entry.classifiedAt?.getTime() ?? null)
  );
}

function entryData(entry: CatalogEntryPlan) {
  return {
    name: entry.name,
    vendor: entry.vendor,
    alias: entry.alias,
    source: entry.source,
    confidence: entry.confidence,
    classifiedAt: entry.classifiedAt,
  };
}

export async function persist(entries: CatalogEntryPlan[], stored: StoredRow[]): Promise<void> {
  const keep = new Set(entries.map(entryKey));
  const priorByKey = new Map(stored.map((row) => [entryKey(row), row]));
  const stale = new Map<string, string[]>();
  for (const row of stored) {
    if (!keep.has(entryKey(row))) stale.set(row.providerId, [...(stale.get(row.providerId) ?? []), row.upstreamId]);
  }
  for (const [providerId, upstreamIds] of stale) {
    await prisma.catalogEntry.deleteMany({ where: { providerId, upstreamId: { in: upstreamIds } } });
  }
  const fresh = entries.filter((entry) => !priorByKey.has(entryKey(entry)));
  if (fresh.length) {
    await prisma.catalogEntry.createMany({
      data: fresh.map((entry) => ({
        providerId: entry.providerId,
        upstreamId: entry.upstreamId,
        disabled: entry.disabled,
        ...entryData(entry),
      })),
      skipDuplicates: true,
    });
  }
  for (const entry of entries) {
    const prior = priorByKey.get(entryKey(entry));
    if (!prior || !changed(prior, entry)) continue;
    await prisma.catalogEntry.updateMany({
      where: { providerId: entry.providerId, upstreamId: entry.upstreamId, updatedAt: prior.updatedAt },
      data: entryData(entry),
    });
  }
}

export async function reconcile(): Promise<void> {
  const inputs = await catalogInputs();
  await persist(inputs.plan.entries, inputs.stored);
}

export async function catalogTargets(providerId: string): Promise<Map<string, CatalogEntryPlan>> {
  const { plan } = await catalogInputs();
  return new Map(
    plan.entries.filter((entry) => entry.providerId === providerId).map((entry) => [entry.upstreamId, entry]),
  );
}
