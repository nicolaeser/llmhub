import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { spendScope } from "@/lib/auth/scope";
import { getSession } from "@/lib/auth/session";
import { liveSince } from "@/lib/gateway/request-logs/log-live";
import { logStream } from "@/lib/gateway/request-logs/log-stream";
import { logFiltersFromSearch } from "@/lib/gateway/request-logs/request-log-query";
import { problemResponse } from "@/lib/http/problem";
import { liveClosing } from "@/lib/updates/live";
import { LIVE_HEADERS, liveSessionAccess } from "@/lib/updates/live-stream";

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
  if (!hasPerm(session.permissions, PERMISSIONS.SPEND_READ)) return problemResponse(req, "FORBIDDEN");
  const url = new URL(req.url);
  const stream = logStream({
    sessionId: session.sessionId,
    scope: spendScope(session),
    filters: logFiltersFromSearch(url.search),
    sinceMs: liveSince(url.searchParams.get("since"), Date.now()),
    signal: req.signal,
    checkAccess: liveSessionAccess(session.workspaceOrgId ?? null),
  });
  return new Response(stream, { headers: LIVE_HEADERS });
}
