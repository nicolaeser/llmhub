import "server-only";

import prisma from "@/lib/db/prisma";
import { requirePermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { spendScope } from "@/lib/auth/scope";
import { writeAudit } from "@/lib/audit";
import { replayDraft } from "@/lib/gateway/request-logs/log-replay";
import type { PlaygroundReplay } from "@/types/playground";

export async function loadReplay(id: string): Promise<PlaygroundReplay> {
  const session = await requirePermission(PERMISSIONS.PLAYGROUND_USE);
  if (
    !hasPerm(session.permissions, PERMISSIONS.SPEND_READ) ||
    !hasPerm(session.permissions, PERMISSIONS.LOGS_CONTENT)
  ) {
    throw new Error("FORBIDDEN");
  }
  if (typeof id !== "string" || !id) throw new Error("MISSING_ID");
  const row = await prisma.requestLog.findFirst({
    where: { id, ...spendScope(session) },
    select: {
      id: true,
      model: true,
      endpoint: true,
      piiInput: true,
      content: { select: { request: true, truncated: true } },
    },
  });
  if (!row) throw new Error("NOT_FOUND");
  const draft = row.content ? replayDraft(row.endpoint, row.content.request) : null;
  if (!row.content || !draft) throw new Error("NOT_REPLAYABLE");
  await writeAudit({
    actor: session.user.id,
    action: "log.content_view",
    objectType: "request_log",
    objectId: row.id,
  });
  return {
    ...draft,
    id: row.id,
    model: row.model,
    truncated: row.content.truncated,
    masked: row.piiInput.length > 0,
  } satisfies PlaygroundReplay;
}
