import { PERMISSIONS } from "@/lib/auth/permissions";
import { resumeNode } from "@/lib/tenancy/structure";
import { managementRoute, respond } from "@/lib/management/http";
import { serializeTeam } from "@/lib/management/serialize";
import { byId } from "@/lib/management/structure";

export const POST = managementRoute<{ id: string }>(PERMISSIONS.TENANCY_MANAGE, async ({ params }) => {
  const structure = await resumeNode({ kind: "team", id: params.id });
  return respond(serializeTeam(byId(structure.teams, params.id, "team"), structure));
});
