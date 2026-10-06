import { rotateKeyAction } from "@/app/(app)/_action";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { managementRoute, respond, unwrap } from "@/lib/management/http";
import { serializeApiKey } from "@/lib/management/serialize";

export const POST = managementRoute<{ id: string }>(PERMISSIONS.KEYS_MANAGE, async ({ params }) => {
  const rotated = unwrap(await rotateKeyAction(params.id));
  return respond(serializeApiKey(rotated.key));
});
