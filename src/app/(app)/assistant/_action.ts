"use server";

import prisma from "@/lib/db/prisma";
import { requirePermission } from "@/lib/auth/guards";
import { disabledAssistantTools } from "@/lib/assistant/access";
import { assistantToolViews, isWriteAccess } from "@/lib/assistant/catalog";
import { assistantModelLocked } from "@/lib/assistant/parse";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { getEnterprise } from "@/lib/gateway/settings";
import { runAction } from "@/lib/http/action-result";

export async function loadAssistantAction() {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.ASSISTANT_USE);
    const [groups, enterprise, disabledTools] = await Promise.all([
      prisma.modelGroup.findMany({
        where: { enabled: true },
        select: { alias: true },
        orderBy: { alias: "asc" },
      }),
      getEnterprise(),
      disabledAssistantTools(session),
    ]);
    const aliases = groups.map((group) => group.alias);
    const preferred = enterprise.assistant_model ?? "";
    const modelLocked = assistantModelLocked(enterprise);
    const models = modelLocked ? aliases.filter((alias) => alias === preferred) : aliases;
    const tools = assistantToolViews({ permissions: session.permissions, disabledTools });
    return {
      models,
      defaultModel: models.includes(preferred) ? preferred : "",
      modelLocked,
      tools,
      canWrite: tools.some((tool) => isWriteAccess(tool.access)),
    };
  });
}
