import { placeMemberAction } from "@/app/(app)/structure/_action";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { managementRoute, notFound, respond, unwrap } from "@/lib/management/http";
import { serializeOrg } from "@/lib/management/serialize";
import { byId, loadStructure } from "@/lib/management/structure";

export const PUT = managementRoute<{ id: string; user_id: string }>(
  PERMISSIONS.TENANCY_MANAGE,
  async ({ params }) => {
    const current = await loadStructure();
    byId(current.orgs, params.id, "organization");
    const user = byId(current.users, params.user_id, "user");
    const team = current.teams.find((row) => row.id === user.teamId);
    const structure = unwrap(
      await placeMemberAction({
        userId: user.id,
        orgId: params.id,
        teamId: team?.orgId === params.id ? team.id : "",
      }),
    );
    return respond(serializeOrg(byId(structure.orgs, params.id, "organization"), structure));
  },
);

export const DELETE = managementRoute<{ id: string; user_id: string }>(
  PERMISSIONS.TENANCY_MANAGE,
  async ({ params }) => {
    const current = await loadStructure();
    byId(current.orgs, params.id, "organization");
    const user = byId(current.users, params.user_id, "user");
    if (user.orgId !== params.id) throw notFound("member");
    const structure = unwrap(await placeMemberAction({ userId: user.id, orgId: "", teamId: "" }));
    return respond(serializeOrg(byId(structure.orgs, params.id, "organization"), structure));
  },
);
