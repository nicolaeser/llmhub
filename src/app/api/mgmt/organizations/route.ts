import { saveOrgAction } from "@/app/(app)/companies/_action";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { managementRoute, readBody, respond, respondList, unwrap } from "@/lib/management/http";
import { serializeOrg } from "@/lib/management/serialize";
import { byAlias, loadStructure } from "@/lib/management/structure";
import { orgWriteSchema } from "@/schemas/management";

export const dynamic = "force-dynamic";

export const GET = managementRoute(PERMISSIONS.TENANCY_READ, async () => {
  const structure = await loadStructure();
  return respondList(structure.orgs.map((org) => serializeOrg(org, structure)));
});

export const POST = managementRoute(PERMISSIONS.TENANCY_MANAGE, async ({ req }) => {
  const body = await readBody(req, orgWriteSchema);
  const structure = unwrap(await saveOrgAction({ alias: body.alias }));
  return respond(serializeOrg(byAlias(structure.orgs, body.alias, "organization"), structure), 201);
});
