import { deleteNodeAction, saveProjectAction } from "@/app/(app)/companies/_action";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { managementRoute, readBody, respond, unwrap } from "@/lib/management/http";
import { serializeProject } from "@/lib/management/serialize";
import { byId, loadStructure } from "@/lib/management/structure";
import { projectUpdateSchema } from "@/schemas/management";

export const dynamic = "force-dynamic";

export const GET = managementRoute<{ id: string }>(PERMISSIONS.TENANCY_READ, async ({ params }) => {
  const structure = await loadStructure();
  return respond(serializeProject(byId(structure.projects, params.id, "project"), structure));
});

export const PATCH = managementRoute<{ id: string }>(PERMISSIONS.TENANCY_MANAGE, async ({ req, params }) => {
  const body = await readBody(req, projectUpdateSchema);
  const existing = byId((await loadStructure()).projects, params.id, "project");
  const structure = unwrap(
    await saveProjectAction({
      id: existing.id,
      alias: body.alias ?? existing.alias,
      orgId: existing.orgId,
      teamId: body.team_id === undefined ? existing.teamId : (body.team_id ?? ""),
      owner: body.owner ?? existing.owner,
    }),
  );
  return respond(serializeProject(byId(structure.projects, params.id, "project"), structure));
});

export const DELETE = managementRoute<{ id: string }>(PERMISSIONS.TENANCY_MANAGE, async ({ params }) => {
  unwrap(await deleteNodeAction({ kind: "project", id: params.id }));
  return respond({ object: "project", id: params.id, deleted: true });
});
