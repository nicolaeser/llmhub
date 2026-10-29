import { PERMISSIONS } from "@/lib/auth/permissions";
import { resumeKey } from "@/lib/keys/manage";
import { managementRoute, respond } from "@/lib/management/http";
import { serializeApiKey } from "@/lib/management/serialize";

export const POST = managementRoute<{ id: string }>(PERMISSIONS.KEYS_MANAGE, async ({ params }) => {
  const resumed = await resumeKey(params.id);
  return respond(serializeApiKey(resumed.key));
});
