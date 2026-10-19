import "server-only";

import prisma from "@/lib/db/prisma";
import { asStringArray } from "@/lib/gateway/core";

type EmptiedGroup = {
  alias: string;
  enabled: boolean;
  billingMode: string;
  overflowGroup: string;
  fallbackGroups: unknown;
  autoRoutes: boolean | null;
  _count: { priceWindows: number };
};

export function catalogOwnedGroups(emptied: EmptiedGroup[], referenced: Set<string>): string[] {
  return emptied
    .filter(
      (group) =>
        group.enabled &&
        group.billingMode === "routed" &&
        group.autoRoutes === null &&
        !group.overflowGroup &&
        asStringArray(group.fallbackGroups).length === 0 &&
        group._count.priceWindows === 0 &&
        !referenced.has(group.alias),
    )
    .map((group) => group.alias);
}

export async function removeProviderConnection(id: string) {
  return prisma.$transaction(async (tx) => {
    const routes = await tx.deployment.findMany({ where: { providerId: id }, select: { groupAlias: true } });
    await tx.deployment.deleteMany({ where: { providerId: id } });
    const row = await tx.providerConnection.delete({ where: { id } });
    const touched = [...new Set(routes.map((route) => route.groupAlias))];
    if (!touched.length) return { row, routes: 0, removedGroups: [], emptyGroups: [] };
    const [emptied, others] = await Promise.all([
      tx.modelGroup.findMany({
        where: { alias: { in: touched }, deployments: { none: {} } },
        select: {
          alias: true,
          enabled: true,
          billingMode: true,
          overflowGroup: true,
          fallbackGroups: true,
          autoRoutes: true,
          _count: { select: { priceWindows: true } },
        },
      }),
      tx.modelGroup.findMany({
        where: { alias: { notIn: touched } },
        select: { overflowGroup: true, fallbackGroups: true },
      }),
    ]);
    const referenced = new Set(others.flatMap((group) => [group.overflowGroup, ...asStringArray(group.fallbackGroups)]));
    const removedGroups = catalogOwnedGroups(emptied, referenced);
    if (removedGroups.length) await tx.modelGroup.deleteMany({ where: { alias: { in: removedGroups } } });
    const emptyGroups = emptied.map((group) => group.alias).filter((alias) => !removedGroups.includes(alias));
    return { row, routes: routes.length, removedGroups, emptyGroups };
  });
}
