import { PERMISSIONS } from "@/lib/auth/permissions";
import { deleteNode, loadStructure, saveMember } from "@/lib/tenancy/structure";
import { managementRoute, readBody, respond } from "@/lib/management/http";
import { serializeMember } from "@/lib/management/serialize";
import { byId } from "@/lib/management/structure";
import { memberUpdateSchema } from "@/schemas/management";

export const dynamic = "force-dynamic";

export const GET = managementRoute<{ id: string }>(PERMISSIONS.TENANCY_READ, async ({ params }) => {
  const structure = await loadStructure();
  return respond(serializeMember(byId(structure.members, params.id, "member"), structure));
});

export const PATCH = managementRoute<{ id: string }>(PERMISSIONS.TENANCY_MANAGE, async ({ req, params }) => {
  const body = await readBody(req, memberUpdateSchema);
  const existing = byId((await loadStructure()).members, params.id, "member");
  const structure = await saveMember({
      id: existing.id,
      alias: body.name ?? existing.alias,
      email: body.email ?? existing.email,
      orgId: existing.orgId,
      teamId: body.team_id === undefined ? existing.teamId : (body.team_id ?? ""),
      blocked: body.blocked ?? existing.blocked,
      logContent: body.log_content ?? existing.logContent,
    });
  return respond(serializeMember(byId(structure.members, params.id, "member"), structure));
});

export const DELETE = managementRoute<{ id: string }>(PERMISSIONS.TENANCY_MANAGE, async ({ params }) => {
  await deleteNode({ kind: "member", id: params.id });
  return respond({ object: "member", id: params.id, deleted: true });
});
