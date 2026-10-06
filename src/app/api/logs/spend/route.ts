import { loadLogsAction } from "@/app/(app)/logs/_action";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { managementRoute, readQuery, respondList, unwrap } from "@/lib/management/http";
import { serializeSpendLog } from "@/lib/management/serialize";
import { logsQuerySchema } from "@/schemas/management";

export const dynamic = "force-dynamic";

export const GET = managementRoute(PERMISSIONS.SPEND_READ, async ({ req }) => {
  const query = readQuery(req, logsQuerySchema);
  const logs = unwrap(
    await loadLogsAction({
      page: query.page,
      pageSize: query.page_size,
      filters: { model: query.model, keyId: query.key_id, userId: query.user_id, from: query.from, to: query.to },
    }),
  );
  return respondList(logs.spend.map(serializeSpendLog), {
    page: logs.page,
    page_size: logs.pageSize,
    total: logs.spendTotal,
  });
});
