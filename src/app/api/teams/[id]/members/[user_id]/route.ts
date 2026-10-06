import { placeMemberAction } from "@/app/(app)/structure/_action";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { managementRoute, notFound, respond, unwrap } from "@/lib/management/http";
import { serializeTeam } from "@/lib/management/serialize";
import { byId, loadStructure } from "@/lib/management/structure";

export const PUT = managementRoute<{ id: string; user_id: string }>(
  PERMISSIONS.TENANCY_MANAGE,
  async ({ params }) => {
    const current = await loadStructure();
    const team = byId(current.teams, params.id, "team");
    const user = byId(current.users, params.user_id, "user");
    const structure = unwrap(await placeMemberAction({ userId: user.id, orgId: team.orgId, teamId: team.id }));
    return respond(serializeTeam(byId(structure.teams, params.id, "team"), structure));
  },
);

export const DELETE = managementRoute<{ id: string; user_id: string }>(
  PERMISSIONS.TENANCY_MANAGE,
  async ({ params }) => {
    const current = await loadStructure();
    byId(current.teams, params.id, "team");
    const user = byId(current.users, params.user_id, "user");
    if (user.teamId !== params.id) throw notFound("member");
    const structure = unwrap(await placeMemberAction({ userId: user.id, orgId: user.orgId, teamId: "" }));
    return respond(serializeTeam(byId(structure.teams, params.id, "team"), structure));
  },
);
