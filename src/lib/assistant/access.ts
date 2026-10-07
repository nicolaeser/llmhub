import "server-only";

import prisma from "@/lib/db/prisma";
import { assistantToolList } from "@/lib/assistant/catalog";
import type { AssistantToolName } from "@/types/assistant";
import type { AuthenticatedSession } from "@/types/auth";

export async function disabledAssistantTools(session: AuthenticatedSession): Promise<AssistantToolName[]> {
  if (session.isOwner || !session.role) return [];
  const role = await prisma.role.findUnique({
    where: { id: session.role.id },
    select: { assistantToolsDisabled: true },
  });
  return assistantToolList(role?.assistantToolsDisabled);
}
