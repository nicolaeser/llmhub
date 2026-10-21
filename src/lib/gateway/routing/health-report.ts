import "server-only";

import prisma from "@/lib/db/prisma";
import { requirePlatformPermission } from "@/lib/auth/guards";
import { PERMISSIONS } from "@/lib/auth/permissions";
import {
  COOLDOWN_MS,
  deploymentHealth,
  HEALTH_RETENTION_MINUTES,
  summarizeHealth,
} from "@/lib/gateway/routing/provider-health";
import type { DeploymentHealthView, HealthReport } from "@/types/provider-health";

function severity(view: DeploymentHealthView): number {
  if (view.cooldownUntil) return 0;
  if (view.failures) return 1;
  if (view.attempts) return 2;
  return 3;
}

function byUrgency(a: DeploymentHealthView, b: DeploymentHealthView): number {
  return (
    severity(a) - severity(b) ||
    b.errorRate - a.errorRate ||
    b.attempts - a.attempts ||
    a.alias.localeCompare(b.alias) ||
    a.model.localeCompare(b.model)
  );
}

export async function loadProviderHealth(minutes = 15): Promise<HealthReport> {
  await requirePlatformPermission(PERMISSIONS.PROVIDERS_READ);
  const span = Math.min(HEALTH_RETENTION_MINUTES, Math.max(1, Math.trunc(Number(minutes)) || 15));
  const rows = await prisma.deployment.findMany({
    select: {
      id: true,
      groupAlias: true,
      kind: true,
      model: true,
      provider: { select: { name: true } },
    },
  });
  const now = Date.now();
  const { backend, states } = await deploymentHealth(
    rows.map((row) => row.id),
    span,
    now,
  );
  const deployments = rows.flatMap((row) => {
    const state = states.get(row.id);
    if (!state) return [];
    return [
      {
        id: row.id,
        alias: row.groupAlias,
        model: row.model,
        kind: row.kind,
        provider: row.provider?.name ?? "",
        cooldownUntil: state.cooldownUntil,
        ...summarizeHealth(state),
      },
    ];
  });
  return {
    minutes: span,
    backend,
    generatedAt: now,
    cooldownMs: COOLDOWN_MS,
    deployments: deployments.sort(byUrgency),
  };
}
