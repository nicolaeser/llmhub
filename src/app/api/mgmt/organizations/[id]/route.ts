import { deleteNodeAction, saveOrgAction } from "@/app/(app)/companies/_action";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { managementRoute, readBody, respond, unwrap } from "@/lib/management/http";
import { serializeOrg } from "@/lib/management/serialize";
import { byId, loadStructure } from "@/lib/management/structure";
import { orgWriteSchema } from "@/schemas/management";

export const dynamic = "force-dynamic";

export const GET = managementRoute<{ id: string }>(PERMISSIONS.TENANCY_READ, async ({ params }) => {
  const structure = await loadStructure();
  return respond(serializeOrg(byId(structure.orgs, params.id, "organization"), structure));
});

export const PATCH = managementRoute<{ id: string }>(PERMISSIONS.TENANCY_MANAGE, async ({ req, params }) => {
  const body = await readBody(req, orgWriteSchema);
  const structure = unwrap(await saveOrgAction({ id: params.id, alias: body.alias }));
  return respond(serializeOrg(byId(structure.orgs, params.id, "organization"), structure));
});

export const DELETE = managementRoute<{ id: string }>(PERMISSIONS.TENANCY_MANAGE, async ({ params }) => {
  unwrap(await deleteNodeAction({ kind: "org", id: params.id }));
  return respond({ object: "organization", id: params.id, deleted: true });
});
