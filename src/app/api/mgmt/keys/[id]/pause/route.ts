import { PERMISSIONS } from "@/lib/auth/permissions";
import { pauseKey } from "@/lib/keys/manage";
import { managementRoute, readBody, respond } from "@/lib/management/http";
import { serializeApiKey } from "@/lib/management/serialize";
import { apiPauseSchema } from "@/schemas/management";

export const POST = managementRoute<{ id: string }>(PERMISSIONS.KEYS_MANAGE, async ({ req, params }) => {
  const body = await readBody(req, apiPauseSchema);
  const paused = await pauseKey({ id: params.id, hours: body.hours });
  return respond(serializeApiKey(paused.key));
});
