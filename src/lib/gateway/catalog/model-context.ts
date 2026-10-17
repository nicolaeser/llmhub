import "server-only";
import prisma from "@/lib/db/prisma";
import { modeSupport } from "@/lib/gateway/dispatch/service-mode";
import { routePool } from "@/lib/gateway/routing/route-pool";
import { discoveredOf } from "@/lib/gateway/upstreams/provider-prices";
import type { CatalogFacts, ContextGroup, ModelVariant } from "@/types/models";
import type { RoutePool } from "@/types/routing";

const SPEED_VARIANTS: readonly ModelVariant[] = ["fast", "ultrafast"];

export function routeCatalogFacts(groups: ContextGroup[]): CatalogFacts {
  const windows: Record<RoutePool, Map<string, number>> = { api: new Map(), subscription: new Map() };
  const speeds: Record<RoutePool, Map<string, ModelVariant[]>> = { api: new Map(), subscription: new Map() };
  for (const group of groups) {
    for (const route of group.deployments) {
      const pool = routePool(route);
      const found = discoveredOf(route.provider?.discovered).find((model) => model.id === route.model);
      if (found && found.contextLength > 0) {
        const known = windows[pool].get(group.alias);
        windows[pool].set(group.alias, known ? Math.min(known, found.contextLength) : found.contextLength);
      }
      const facts = found ? { serviceTiers: found.serviceTiers, accessPrograms: found.accessPrograms } : undefined;
      const confirmed = SPEED_VARIANTS.filter(
        (variant) => modeSupport({ kind: route.kind, model: route.model, facts }, variant) === "confirmed",
      );
      const known = speeds[pool].get(group.alias) ?? [];
      speeds[pool].set(group.alias, SPEED_VARIANTS.filter((variant) => known.includes(variant) || confirmed.includes(variant)));
    }
  }
  return { windows, speeds };
}

export async function catalogFacts(): Promise<CatalogFacts> {
  const groups = await prisma.modelGroup.findMany({
    where: { enabled: true },
    select: {
      alias: true,
      deployments: { select: { kind: true, model: true, provider: { select: { kind: true, discovered: true } } } },
    },
  });
  return routeCatalogFacts(groups);
}
