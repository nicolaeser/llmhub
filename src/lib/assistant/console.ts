import "server-only";

import { enabledAliases } from "@/lib/models/aliases";
import { requirePermission } from "@/lib/auth/guards";
import { disabledAssistantTools } from "@/lib/assistant/access";
import { assistantToolViews, isWriteAccess } from "@/lib/assistant/catalog";
import { assistantModelLocked } from "@/lib/assistant/parse";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { getEnterprise } from "@/lib/settings/enterprise";

export async function loadAssistant() {
  const session = await requirePermission(PERMISSIONS.ASSISTANT_USE);
  const [aliases, enterprise, disabledTools] = await Promise.all([
    enabledAliases(),
    getEnterprise(),
    disabledAssistantTools(session),
  ]);
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
}
