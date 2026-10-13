import { PERMISSIONS } from "@/lib/auth/permissions";
import { deleteNode, loadStructure, saveOrg } from "@/lib/tenancy/structure";
import { managementRoute, readBody, respond } from "@/lib/management/http";
import { serializeOrg } from "@/lib/management/serialize";
import { byId } from "@/lib/management/structure";
import { orgWriteSchema } from "@/schemas/management";

export const dynamic = "force-dynamic";

export const GET = managementRoute<{ id: string }>(PERMISSIONS.TENANCY_READ, async ({ params }) => {
  const structure = await loadStructure();
  return respond(serializeOrg(byId(structure.orgs, params.id, "organization"), structure));
});

export const PATCH = managementRoute<{ id: string }>(PERMISSIONS.TENANCY_MANAGE, async ({ req, params }) => {
  const body = await readBody(req, orgWriteSchema);
  const structure = await saveOrg({ id: params.id, alias: body.alias });
  return respond(serializeOrg(byId(structure.orgs, params.id, "organization"), structure));
});

export const DELETE = managementRoute<{ id: string }>(PERMISSIONS.TENANCY_MANAGE, async ({ params }) => {
  await deleteNode({ kind: "org", id: params.id });
  return respond({ object: "organization", id: params.id, deleted: true });
});
