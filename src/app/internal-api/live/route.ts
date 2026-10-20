import { spendScope } from "@/lib/auth/scope";
import { getSession } from "@/lib/auth/session";
import { problemResponse } from "@/lib/http/problem";
import { liveClosing } from "@/lib/updates/live";
import { parseLiveTopics } from "@/lib/updates/live-events";
import { LIVE_HEADERS, liveAccess, liveStream } from "@/lib/updates/live-stream";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (liveClosing()) {
    const closing = problemResponse(req, "SERVICE_UNAVAILABLE");
    closing.headers.set("Connection", "close");
    closing.headers.set("Retry-After", "5");
    return closing;
  }
  const session = await getSession();
  if (session.error) return problemResponse(req, "UNAUTHORIZED");
  const stream = liveStream({
    sessionId: session.sessionId,
    access: liveAccess(session.permissions, spendScope(session)),
    topics: parseLiveTopics(new URL(req.url).searchParams.get("topics")),
    workspaceOrgId: session.workspaceOrgId ?? null,
    signal: req.signal,
  });
  return new Response(stream, { headers: LIVE_HEADERS });
}
