import "server-only";
import prisma from "@/lib/db/prisma";
import { isPrismaCode } from "@/lib/auth/errors";
import { writeAudit } from "@/lib/audit";
import { reconcile, storedSelect, type StoredRow } from "@/lib/gateway/catalog/catalog-entries";
import { activationEntries, trustedKind } from "@/lib/gateway/catalog/model-catalog";
import { isReservedAlias } from "@/lib/gateway/catalog/model-alias";
import { discoveredOf } from "@/lib/gateway/upstreams/provider-prices";
import { catalogRouting, getEnterprise } from "@/lib/settings/enterprise";
import type { DiscoveredModel } from "@/types/providers";
import type { CatalogSource } from "@/types/model-catalog";

const IMPORT_STRATEGY = "cost_lowest";
const IMPORT_RETRIES = 2;

type RouteTarget = {
  provider: { id: string; kind: string };
  model: DiscoveredModel;
  alias: string;
  vendor: string;
  displayName: string;
  strategy?: string;
};

type EntryRef = { providerId: string; upstreamId: string };

export async function addRoute(target: RouteTarget): Promise<"created" | "added" | "updated"> {
  const deployment = {
    kind: target.provider.kind,
    model: target.model.id,
    providerId: target.provider.id,
    weight: 1,
    costInput: target.model.costInputPer1k,
    costOutput: target.model.costOutputPer1k,
  };
  const existing = await prisma.modelGroup.findUnique({
    where: { alias: target.alias },
    select: { vendor: true, displayName: true, deployments: { select: { id: true, providerId: true, model: true } } },
  });
  if (!existing) {
    try {
      await prisma.modelGroup.create({
        data: {
          alias: target.alias,
          strategy: target.strategy ?? IMPORT_STRATEGY,
          numRetries: IMPORT_RETRIES,
          vendor: target.vendor,
          displayName: target.displayName,
          deployments: { create: deployment },
        },
      });
      return "created";
    } catch (error) {
      if (!isPrismaCode(error, "P2002")) throw error;
      await prisma.deployment.create({ data: { groupAlias: target.alias, ...deployment } });
      return "added";
    }
  }
  if (!existing.vendor || !existing.displayName) {
    await prisma.modelGroup.update({
      where: { alias: target.alias },
      data: { vendor: existing.vendor || target.vendor, displayName: existing.displayName || target.displayName },
    });
  }
  const duplicate = existing.deployments.find(
    (dep) => dep.providerId === target.provider.id && dep.model === target.model.id,
  );
  if (duplicate) {
    await prisma.deployment.update({
      where: { id: duplicate.id },
      data: { costInput: deployment.costInput, costOutput: deployment.costOutput },
    });
    return "updated";
  }
  await prisma.deployment.create({ data: { groupAlias: target.alias, ...deployment } });
  return "added";
}

export async function markRouted(entry: {
  providerId: string;
  upstreamId: string;
  alias: string;
  name: string;
  vendor: string;
}): Promise<void> {
  const data = { alias: entry.alias, source: "route", confidence: 1, disabled: false };
  await prisma.catalogEntry.upsert({
    where: { providerId_upstreamId: { providerId: entry.providerId, upstreamId: entry.upstreamId } },
    update: data,
    create: { providerId: entry.providerId, upstreamId: entry.upstreamId, name: entry.name, vendor: entry.vendor, ...data },
  });
}

async function routeTarget(ref: EntryRef) {
  const [entry, provider] = await Promise.all([
    prisma.catalogEntry.findUnique({
      where: { providerId_upstreamId: ref },
      select: storedSelect,
    }),
    prisma.providerConnection.findUnique({
      where: { id: ref.providerId },
      select: { id: true, kind: true, discovered: true },
    }),
  ]);
  if (!entry || !provider) throw new Error("NOT_FOUND");
  if (!entry.alias) throw new Error("CATALOG_TARGET_REQUIRED");
  const model =
    discoveredOf(provider.discovered).find((item) => item.id === entry.upstreamId) ??
    ({
      id: entry.upstreamId,
      name: entry.name || entry.upstreamId,
      ownedBy: "",
      contextLength: 0,
      costInputPer1k: 0,
      costOutputPer1k: 0,
      priceSource: "none",
    } satisfies DiscoveredModel);
  return { entry, provider, model };
}

async function unroute(entry: StoredRow): Promise<number> {
  const removed = await prisma.deployment.deleteMany({
    where: { groupAlias: entry.alias, providerId: entry.providerId, model: entry.upstreamId },
  });
  return removed.count;
}

export async function setEntryActive(actor: string, ref: EntryRef, active: boolean): Promise<void> {
  const { entry, provider, model } = await routeTarget(ref);
  if (active) {
    const outcome = await addRoute({
      provider,
      model,
      alias: entry.alias,
      vendor: entry.vendor,
      displayName: entry.name,
    });
    await markRouted(entry);
    await writeAudit({
      actor,
      action: "catalog.route_enable",
      objectType: "model",
      objectId: entry.alias,
      after: { provider: entry.providerId, model: entry.upstreamId, outcome },
    });
  } else {
    const removed = await unroute(entry);
    await prisma.catalogEntry.update({
      where: { providerId_upstreamId: ref },
      data: { disabled: true, source: "manual", confidence: 1 },
    });
    await writeAudit({
      actor,
      action: "catalog.route_disable",
      objectType: "model",
      objectId: entry.alias,
      after: { provider: entry.providerId, model: entry.upstreamId, removed },
    });
  }
  await reconcile();
}

export async function assignEntry(actor: string, ref: EntryRef, alias: string): Promise<void> {
  const { entry, provider, model } = await routeTarget(ref);
  if (!alias) throw new Error("ALIAS_REQUIRED");
  if (isReservedAlias(alias)) throw new Error("ALIAS_RESERVED");
  if (alias === entry.alias) return;
  const wasRouted = entry.source === "route" && (await unroute(entry)) > 0;
  await prisma.catalogEntry.update({
    where: { providerId_upstreamId: ref },
    data: { alias, source: "manual", confidence: 1, disabled: false },
  });
  if (wasRouted) {
    await addRoute({ provider, model, alias, vendor: entry.vendor, displayName: entry.name });
    await markRouted({ ...entry, alias });
  }
  await writeAudit({
    actor,
    action: "catalog.assign",
    objectType: "model",
    objectId: alias,
    before: { alias: entry.alias },
    after: { provider: entry.providerId, model: entry.upstreamId, alias, routed: wasRouted },
  });
  await reconcile();
}

export async function setGroupActive(actor: string, alias: string, active: boolean): Promise<void> {
  const group = await prisma.modelGroup.findUnique({ where: { alias }, select: { enabled: true } });
  if (group) {
    if (group.enabled === active) return;
    await prisma.modelGroup.update({ where: { alias }, data: { enabled: active } });
    await writeAudit({
      actor,
      action: active ? "model.enable" : "model.disable",
      objectType: "model",
      objectId: alias,
      before: { enabled: group.enabled },
      after: { enabled: active },
    });
    return;
  }
  if (!active) return;
  const rows = await prisma.catalogEntry.findMany({ where: { alias }, select: storedSelect });
  const routing = catalogRouting(await getEnterprise());
  const providers = await prisma.providerConnection.findMany({
    where: { id: { in: [...new Set(rows.map((row) => row.providerId))] } },
    select: { id: true, kind: true, discovered: true },
  });
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const due = activationEntries(
    rows.flatMap((row) => {
      const provider = byId.get(row.providerId);
      return provider ? [{ ...row, source: row.source as CatalogSource, trusted: trustedKind(provider.kind), provider }] : [];
    }),
    routing.minConfidence,
  );
  if (!due.length) throw new Error("CATALOG_NOTHING_TO_ACTIVATE");
  for (const row of due) {
    const model = discoveredOf(row.provider.discovered).find((item) => item.id === row.upstreamId);
    if (!model) continue;
    await addRoute({
      provider: row.provider,
      model,
      alias,
      vendor: row.vendor,
      displayName: row.name,
    });
    await markRouted(row);
  }
  await writeAudit({
    actor,
    action: "catalog.activate",
    objectType: "model",
    objectId: alias,
    after: { routes: due.map((row) => ({ provider: row.providerId, model: row.upstreamId })) },
  });
  await reconcile();
}

export async function setGroupAutoRoutes(actor: string, alias: string, autoRoutes: boolean | null): Promise<void> {
  const group = await prisma.modelGroup.findUnique({ where: { alias }, select: { autoRoutes: true } });
  if (!group) throw new Error("NOT_FOUND");
  if (group.autoRoutes === autoRoutes) return;
  await prisma.modelGroup.update({ where: { alias }, data: { autoRoutes } });
  await writeAudit({
    actor,
    action: "model.auto_routes",
    objectType: "model",
    objectId: alias,
    before: { autoRoutes: group.autoRoutes },
    after: { autoRoutes },
  });
}
