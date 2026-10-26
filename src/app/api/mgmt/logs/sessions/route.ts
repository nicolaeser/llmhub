import { PERMISSIONS } from "@/lib/auth/permissions";
import { loadLogSessions } from "@/lib/gateway/request-logs/sessions";
import { managementRoute, readQuery, respondList } from "@/lib/management/http";
import { serializeRequestSession } from "@/lib/management/serialize";
import { sessionsQuerySchema } from "@/schemas/management";
import { storedLabel } from "@/lib/usage/labels";

export const dynamic = "force-dynamic";

export const GET = managementRoute(PERMISSIONS.SPEND_READ, async ({ req }) => {
  const query = readQuery(req, sessionsQuerySchema);
  const sessions = await loadLogSessions({
    page: query.page,
    pageSize: query.page_size,
    sort: { by: query.sort, direction: query.order },
    filters: {
      model: query.model,
      endpoint: query.endpoint,
      keyId: query.key_id,
      userId: query.user_id,
      label: query.label ? storedLabel(query.label) : "",
      session: query.session,
      status: query.status === undefined ? "" : String(query.status),
      from: query.from,
      to: query.to,
    },
  });
  return respondList(sessions.sessions.map(serializeRequestSession), {
    page: sessions.page,
    page_size: sessions.pageSize,
    total: sessions.total,
    total_capped: sessions.capped,
    totals: {
      active_sessions: sessions.totals.active,
      requests: sessions.totals.requests,
      errors: sessions.totals.errors,
      cost: sessions.totals.cost,
      prompt_tokens: sessions.totals.promptTokens,
      completion_tokens: sessions.totals.completionTokens,
      cache_read_tokens: sessions.totals.cacheReadTokens,
    },
  });
});
