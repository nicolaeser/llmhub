import { saveMemberAction } from "@/app/(app)/companies/_action";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { managementRoute, notFound, readBody, respond, respondList, unwrap } from "@/lib/management/http";
import { serializeMember } from "@/lib/management/serialize";
import { loadStructure } from "@/lib/management/structure";
import { memberCreateSchema } from "@/schemas/management";

export const dynamic = "force-dynamic";

export const GET = managementRoute(PERMISSIONS.TENANCY_READ, async () => {
  const structure = await loadStructure();
  return respondList(structure.members.map((row) => serializeMember(row, structure)));
});

export const POST = managementRoute(PERMISSIONS.TENANCY_MANAGE, async ({ req }) => {
  const body = await readBody(req, memberCreateSchema);
  const before = new Set((await loadStructure()).members.map((row) => row.id));
  const structure = unwrap(
    await saveMemberAction({
      alias: body.name,
      email: body.email,
      orgId: body.org_id,
      teamId: body.team_id ?? "",
      blocked: body.blocked,
      logContent: body.log_content,
    }),
  );
  const created = structure.members.find((row) => !before.has(row.id));
  if (!created) throw notFound("member");
  return respond(serializeMember(created, structure), 201);
});
