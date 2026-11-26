import type { NextRequest } from "next/server";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { spendScope } from "@/lib/auth/scope";
import { getSession } from "@/lib/auth/session";
import { readAttachment } from "@/lib/gateway/request-logs/attachment-store";
import { attachmentHeaders } from "@/lib/gateway/request-logs/log-attachments";
import { problemResponse } from "@/lib/http/problem";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (session.error) return problemResponse(req, "UNAUTHORIZED");
  if (!hasPerm(session.permissions, PERMISSIONS.SPEND_READ) || !hasPerm(session.permissions, PERMISSIONS.LOGS_CONTENT)) {
    return problemResponse(req, "FORBIDDEN");
  }
  const { id } = await ctx.params;
  const found = await readAttachment(spendScope(session), id);
  if (!found) return problemResponse(req, "NOT_FOUND");
  return new Response(new Uint8Array(found.payload), { headers: attachmentHeaders(id, found.contentType) });
}
