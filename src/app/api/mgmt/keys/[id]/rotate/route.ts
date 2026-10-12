import { PERMISSIONS } from "@/lib/auth/permissions";
import { rotateKey } from "@/lib/keys/manage";
import { managementRoute, respond } from "@/lib/management/http";
import { serializeApiKey } from "@/lib/management/serialize";

export const POST = managementRoute<{ id: string }>(PERMISSIONS.KEYS_MANAGE, async ({ params }) => {
  const rotated = await rotateKey(params.id);
  return respond(serializeApiKey(rotated.key));
});
