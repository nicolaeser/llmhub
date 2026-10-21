import "server-only";

import prisma from "@/lib/db/prisma";
import { requirePermission } from "@/lib/auth/guards";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { setupLinks } from "@/lib/auth/scope";
import { listedIn, routePool } from "@/lib/gateway/routing/route-pool";
import { chatChoices, modelRole, type ModelRole } from "@/lib/models/model-role";
import type { PooledModelChoice } from "@/types/models";

export async function enabledModelChoices(): Promise<PooledModelChoice[]> {
  const groups = await prisma.modelGroup.findMany({
    where: { enabled: true },
    select: {
      alias: true,
      displayName: true,
      deployments: { select: { kind: true, model: true, provider: { select: { kind: true, internal: true } } } },
    },
    orderBy: { alias: "asc" },
  });
  return groups.map((group) => ({
    alias: group.alias,
    label: group.displayName || group.alias,
    role: modelRole([...group.deployments.map((deployment) => deployment.model), group.alias, group.displayName]),
    pools: [...new Set(group.deployments.map(routePool))],
  }));
}

export async function apiModelChoices(): Promise<PooledModelChoice[]> {
  return (await enabledModelChoices()).filter((choice) => listedIn(choice, "api"));
}

export async function assertModelRoles(checks: { alias: string; role: ModelRole }[]): Promise<void> {
  const wanted = checks.filter((check) => check.alias);
  if (!wanted.length) return;
  const groups = await prisma.modelGroup.findMany({
    where: { alias: { in: [...new Set(wanted.map((check) => check.alias))] } },
    select: { alias: true, displayName: true, deployments: { select: { model: true } } },
  });
  const byAlias = new Map(groups.map((group) => [group.alias, group]));
  for (const check of wanted) {
    const group = byAlias.get(check.alias);
    if (!group) throw new Error("UNKNOWN_MODEL");
    const actual = modelRole([
      ...group.deployments.map((deployment) => deployment.model),
      group.alias,
      group.displayName,
    ]);
    if (actual !== "chat" && actual !== check.role) throw new Error("MODEL_ROLE");
  }
}

export async function loadAliases() {
  const session = await requirePermission(PERMISSIONS.PLAYGROUND_USE);
  const [choices, providers] = await Promise.all([
    apiModelChoices(),
    prisma.providerConnection.count(),
  ]);
  return { models: chatChoices(choices).map((choice) => choice.alias), providers, setupLinks: setupLinks(session) };
}
