import "server-only";

import prisma from "@/lib/db/prisma";
import { requirePermission } from "@/lib/auth/guards";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { setupLinks } from "@/lib/auth/scope";
import { chatChoices, modelRole, type ModelChoice, type ModelRole } from "@/lib/models/model-role";

export async function enabledModelChoices(): Promise<ModelChoice[]> {
  const groups = await prisma.modelGroup.findMany({
    where: { enabled: true },
    select: { alias: true, displayName: true, deployments: { select: { model: true } } },
    orderBy: { alias: "asc" },
  });
  return groups.map((group) => ({
    alias: group.alias,
    label: group.displayName || group.alias,
    role: modelRole([...group.deployments.map((deployment) => deployment.model), group.alias, group.displayName]),
  }));
}

export async function enabledAliases(): Promise<string[]> {
  return (await enabledModelChoices()).map((choice) => choice.alias);
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
    enabledModelChoices(),
    prisma.providerConnection.count(),
  ]);
  return { models: chatChoices(choices).map((choice) => choice.alias), providers, setupLinks: setupLinks(session) };
}
