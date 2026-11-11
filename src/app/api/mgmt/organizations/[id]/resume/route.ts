import { PERMISSIONS } from "@/lib/auth/permissions";
import { resumeNode } from "@/lib/tenancy/structure";
import { managementRoute, respond } from "@/lib/management/http";
import { serializeOrg } from "@/lib/management/serialize";
import { byId } from "@/lib/management/structure";

export const POST = managementRoute<{ id: string }>(PERMISSIONS.TENANCY_MANAGE, async ({ params }) => {
  const structure = await resumeNode({ kind: "org", id: params.id });
  return respond(serializeOrg(byId(structure.orgs, params.id, "organization"), structure));
});
