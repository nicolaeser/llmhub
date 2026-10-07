import { deleteNodeAction, saveTeamAction } from "@/app/(app)/companies/_action";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { managementRoute, readBody, respond, unwrap } from "@/lib/management/http";
import { serializeTeam } from "@/lib/management/serialize";
import { byId, loadStructure } from "@/lib/management/structure";
import { teamUpdateSchema } from "@/schemas/management";

export const dynamic = "force-dynamic";

export const GET = managementRoute<{ id: string }>(PERMISSIONS.TENANCY_READ, async ({ params }) => {
  const structure = await loadStructure();
  return respond(serializeTeam(byId(structure.teams, params.id, "team"), structure));
});

export const PATCH = managementRoute<{ id: string }>(PERMISSIONS.TENANCY_MANAGE, async ({ req, params }) => {
  const body = await readBody(req, teamUpdateSchema);
  const existing = byId((await loadStructure()).teams, params.id, "team");
  const structure = unwrap(
    await saveTeamAction({
      id: existing.id,
      alias: body.alias ?? existing.alias,
      orgId: existing.orgId,
      rpm: body.rpm_limit ?? existing.rpmLimit,
      tpm: body.tpm_limit ?? existing.tpmLimit,
    }),
  );
  return respond(serializeTeam(byId(structure.teams, params.id, "team"), structure));
});

export const DELETE = managementRoute<{ id: string }>(PERMISSIONS.TENANCY_MANAGE, async ({ params }) => {
  unwrap(await deleteNodeAction({ kind: "team", id: params.id }));
  return respond({ object: "team", id: params.id, deleted: true });
});
