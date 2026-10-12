import { loadUsageAction } from "@/app/(app)/_action";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { managementRoute, readQuery, respond, unwrap } from "@/lib/management/http";
import { serializeUsage } from "@/lib/management/serialize";
import { usageQuerySchema } from "@/schemas/management";

export const dynamic = "force-dynamic";

export const GET = managementRoute(PERMISSIONS.SPEND_READ, async ({ req }) => {
  const query = readQuery(req, usageQuerySchema);
  const usage = unwrap(
    await loadUsageAction({
      days: query.days,
      model: query.model,
      teamId: query.team_id,
      orgId: query.org_id,
      projectId: query.project_id,
      memberId: query.member_id,
      keyId: query.key_id,
      userId: query.user_id,
    }),
  );
  return respond(serializeUsage(usage));
});
