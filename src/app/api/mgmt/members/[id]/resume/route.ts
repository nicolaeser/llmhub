import { PERMISSIONS } from "@/lib/auth/permissions";
import { resumeNode } from "@/lib/tenancy/structure";
import { managementRoute, respond } from "@/lib/management/http";
import { serializeMember } from "@/lib/management/serialize";
import { byId } from "@/lib/management/structure";

export const POST = managementRoute<{ id: string }>(PERMISSIONS.TENANCY_MANAGE, async ({ params }) => {
  const structure = await resumeNode({ kind: "member", id: params.id });
  return respond(serializeMember(byId(structure.members, params.id, "member"), structure));
});
