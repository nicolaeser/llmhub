import { saveProjectAction } from "@/app/(app)/companies/_action";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { managementRoute, readBody, respond, respondList, unwrap } from "@/lib/management/http";
import { serializeProject } from "@/lib/management/serialize";
import { byAlias, loadStructure } from "@/lib/management/structure";
import { projectCreateSchema } from "@/schemas/management";

export const dynamic = "force-dynamic";

export const GET = managementRoute(PERMISSIONS.TENANCY_READ, async () => {
  const structure = await loadStructure();
  return respondList(structure.projects.map((project) => serializeProject(project, structure)));
});

export const POST = managementRoute(PERMISSIONS.TENANCY_MANAGE, async ({ req }) => {
  const body = await readBody(req, projectCreateSchema);
  const structure = unwrap(
    await saveProjectAction({
      alias: body.alias,
      orgId: body.org_id,
      teamId: body.team_id ?? "",
      owner: body.owner,
    }),
  );
  const projects = structure.projects.filter((project) => project.orgId === body.org_id);
  return respond(serializeProject(byAlias(projects, body.alias, "project"), structure), 201);
});
