import { createKeyAction, loadKeysPageAction } from "@/app/(app)/_action";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { managementRoute, readBody, respond, respondList, unwrap } from "@/lib/management/http";
import { serializeApiKey } from "@/lib/management/serialize";
import { apiKeyCreateSchema } from "@/schemas/management";

export const dynamic = "force-dynamic";

export const GET = managementRoute(PERMISSIONS.KEYS_READ, async () => {
  const page = unwrap(await loadKeysPageAction());
  return respondList(page.keys.map(serializeApiKey));
});

export const POST = managementRoute(PERMISSIONS.KEYS_MANAGE, async ({ req }) => {
  const body = await readBody(req, apiKeyCreateSchema);
  const created = unwrap(
    await createKeyAction({
      alias: body.alias,
      projectId: body.project_id ?? "",
      memberId: body.member_id ?? "",
      models: body.models,
      templateIds: body.template_ids,
      rpm: body.rpm_limit,
      tpm: body.tpm_limit,
      allowedIps: body.allowed_ips,
      allowedEndpoints: body.allowed_endpoints,
      accessWindows: body.access_windows,
      accessTimeZone: body.access_time_zone,
      logContent: body.log_content,
      days: body.expires_in_days,
    }),
  );
  return respond(serializeApiKey(created.key), 201);
});
