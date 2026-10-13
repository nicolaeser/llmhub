import { parseScimPage, scimHandler, scimJson, scimList } from "@/lib/auth/scim";
import { createScimGroup, listScimGroups, parseScimGroupBody, toScimGroup } from "@/lib/auth/scim-groups";
import { clientIp } from "@/lib/http/api";
import { readJsonOr } from "@/lib/utils/json";

export const dynamic = "force-dynamic";

function excludesMembers(url: URL): boolean {
  return (url.searchParams.get("excludedAttributes") ?? "")
    .split(",")
    .some((name) => name.trim().toLowerCase() === "members");
}

export const GET = scimHandler("groups.list", async (req) => {
  const url = new URL(req.url);
  const page = parseScimPage(url);
  const { total, groups } = await listScimGroups(url.searchParams.get("filter"), page, !excludesMembers(url));
  return scimJson(scimList(groups.map(toScimGroup), total, page));
});

export const POST = scimHandler("groups.create", async (req) => {
  const group = await createScimGroup(parseScimGroupBody(await readJsonOr(req, null)), clientIp(req.headers) || null);
  return scimJson(toScimGroup(group), 201);
});
