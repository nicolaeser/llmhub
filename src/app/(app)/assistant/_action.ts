"use server";

import prisma from "@/lib/db/prisma";
import { requirePermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { getEnterprise } from "@/lib/gateway/settings";
import { runAction } from "@/lib/http/action-result";

const WRITE_PERMISSIONS = [
  PERMISSIONS.PROVIDERS_MANAGE,
  PERMISSIONS.MODELS_MANAGE,
  PERMISSIONS.KEYS_MANAGE,
] as const;

export async function loadAssistantAction() {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.ASSISTANT_USE);
    const [groups, enterprise] = await Promise.all([
      prisma.modelGroup.findMany({
        select: { alias: true },
        orderBy: { alias: "asc" },
      }),
      getEnterprise(),
    ]);
    const models = groups.map((group) => group.alias);
    const preferred = enterprise.assistant_model ?? "";
    return {
      models,
      defaultModel: models.includes(preferred) ? preferred : "",
      canWrite: WRITE_PERMISSIONS.some((permission) =>
        hasPerm(session.permissions, permission),
      ),
    };
  });
}
