import { loadKeysPageAction, revokeKeyAction, updateKeyAction } from "@/app/(app)/_action";
import { toKeyView } from "@/app/(app)/_data";
import prisma from "@/lib/db/prisma";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { keyVisibleTo } from "@/lib/auth/scope";
import { managementRoute, notFound, readBody, respond, unwrap } from "@/lib/management/http";
import { serializeApiKey } from "@/lib/management/serialize";
import { apiKeyUpdateSchema } from "@/schemas/management";

export const dynamic = "force-dynamic";

export const GET = managementRoute<{ id: string }>(PERMISSIONS.KEYS_READ, async ({ params }) => {
  const key = unwrap(await loadKeysPageAction()).keys.find((row) => row.token_id === params.id);
  if (!key) throw notFound("key");
  return respond(serializeApiKey(key));
});

export const PATCH = managementRoute<{ id: string }>(PERMISSIONS.KEYS_MANAGE, async ({ req, principal, params }) => {
  const body = await readBody(req, apiKeyUpdateSchema);
  const row = await prisma.virtualKey.findUnique({
    where: { id: params.id },
    include: { templates: { select: { templateId: true } } },
  });
  if (!row || !keyVisibleTo(principal, row)) throw notFound("key");
  const current = toKeyView(row);
  const rebinds = body.project_id !== undefined || body.member_id !== undefined;
  const updated = unwrap(
    await updateKeyAction({
      id: current.token_id,
      alias: body.alias ?? (current.key_alias || current.key_name),
      projectId: rebinds ? (body.project_id ?? "") : current.project_id,
      memberId: rebinds ? (body.member_id ?? "") : current.member_id,
      models: body.models ?? current.models,
      templateIds: body.template_ids ?? current.templates,
      rpm: body.rpm_limit ?? current.rpm_limit,
      tpm: body.tpm_limit ?? current.tpm_limit,
      allowedIps: body.allowed_ips ?? current.allowed_ips,
      allowedEndpoints: body.allowed_endpoints ?? current.allowed_endpoints,
      accessWindows: body.access_windows ?? current.access_windows,
      accessTimeZone: body.access_time_zone ?? current.access_time_zone,
      logContent: body.log_content ?? current.log_content,
      blocked: body.blocked ?? current.blocked,
    }),
  );
  return respond(serializeApiKey(updated.key));
});

export const DELETE = managementRoute<{ id: string }>(PERMISSIONS.KEYS_MANAGE, async ({ params }) => {
  const revoked = unwrap(await revokeKeyAction(params.id));
  return respond({ object: "api_key", id: revoked.id, deleted: true });
});
