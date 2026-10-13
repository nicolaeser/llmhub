import "server-only";

import prisma from "@/lib/db/prisma";
import { requirePermission } from "@/lib/auth/guards";
import { PERMISSIONS } from "@/lib/auth/permissions";

export async function enabledAliases(): Promise<string[]> {
  const groups = await prisma.modelGroup.findMany({
    where: { enabled: true },
    select: { alias: true },
    orderBy: { alias: "asc" },
  });
  return groups.map((group) => group.alias);
}

export async function loadAliases() {
  await requirePermission(PERMISSIONS.PLAYGROUND_USE);
  const [models, providers] = await Promise.all([
    enabledAliases(),
    prisma.providerConnection.count(),
  ]);
  return { models, providers };
}
