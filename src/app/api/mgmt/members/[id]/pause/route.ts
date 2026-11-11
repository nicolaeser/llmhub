import { PERMISSIONS } from "@/lib/auth/permissions";
import { pauseNode } from "@/lib/tenancy/structure";
import { managementRoute, readBody, respond } from "@/lib/management/http";
import { serializeMember } from "@/lib/management/serialize";
import { byId } from "@/lib/management/structure";
import { apiPauseSchema } from "@/schemas/management";

export const POST = managementRoute<{ id: string }>(PERMISSIONS.TENANCY_MANAGE, async ({ req, params }) => {
  const body = await readBody(req, apiPauseSchema);
  const structure = await pauseNode({ kind: "member", id: params.id, hours: body.hours });
  return respond(serializeMember(byId(structure.members, params.id, "member"), structure));
});
