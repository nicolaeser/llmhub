"use server";

import prisma from "@/lib/db/prisma";
import { requirePermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { spendScope } from "@/lib/auth/scope";
import { writeAudit } from "@/lib/gateway/audit";
import { replayDraft } from "@/lib/gateway/log-replay";
import { actionFail, runAction } from "@/lib/http/action-result";
import type { PlaygroundReplay } from "@/types/playground";

export async function loadReplayAction(id: string) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.PLAYGROUND_USE);
    if (
      !hasPerm(session.permissions, PERMISSIONS.SPEND_READ) ||
      !hasPerm(session.permissions, PERMISSIONS.LOGS_CONTENT)
    ) {
      return actionFail("FORBIDDEN");
    }
    if (typeof id !== "string" || !id) return actionFail("MISSING_ID");
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
    if (!row) return actionFail("NOT_FOUND");
    const draft = row.content ? replayDraft(row.endpoint, row.content.request) : null;
    if (!row.content || !draft) return actionFail("NOT_REPLAYABLE");
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
  });
}
