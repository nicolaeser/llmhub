import { PERMISSIONS } from "@/lib/auth/permissions";
import { loadStructure, saveTeam } from "@/lib/tenancy/structure";
import { managementRoute, readBody, respond, respondList } from "@/lib/management/http";
import { serializeTeam } from "@/lib/management/serialize";
import { byAlias } from "@/lib/management/structure";
import { teamCreateSchema } from "@/schemas/management";

export const dynamic = "force-dynamic";

export const GET = managementRoute(PERMISSIONS.TENANCY_READ, async () => {
  const structure = await loadStructure();
  return respondList(structure.teams.map((team) => serializeTeam(team, structure)));
});

export const POST = managementRoute(PERMISSIONS.TENANCY_MANAGE, async ({ req }) => {
  const body = await readBody(req, teamCreateSchema);
  const structure = await saveTeam({
      alias: body.alias,
      orgId: body.org_id,
      rpm: body.rpm_limit,
      tpm: body.tpm_limit,
    });
  const teams = structure.teams.filter((team) => team.orgId === body.org_id);
  return respond(serializeTeam(byAlias(teams, body.alias, "team"), structure), 201);
});
