import { scimError, scimHandler, scimJson } from "@/lib/auth/scim";
import {
  deleteScimGroup,
  getScimGroup,
  parseScimGroupBody,
  parseScimGroupPatch,
  patchScimGroup,
  replaceScimGroup,
  toScimGroup,
} from "@/lib/auth/scim-groups";
import { clientIp } from "@/lib/http/api";
import { readJsonOr } from "@/lib/utils/json";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export const GET = scimHandler("groups.get", async (req, ctx: Context) => {
  const excluded = new URL(req.url).searchParams.get("excludedAttributes") ?? "";
  const withMembers = !excluded.split(",").some((name) => name.trim().toLowerCase() === "members");
  const group = await getScimGroup((await ctx.params).id, withMembers);
  if (!group) return scimError(404, "not found");
  return scimJson(toScimGroup(group));
});

export const PUT = scimHandler("groups.replace", async (req, ctx: Context) => {
  const input = parseScimGroupBody(await readJsonOr(req, null));
  const group = await replaceScimGroup((await ctx.params).id, input, clientIp(req.headers) || null);
  return scimJson(toScimGroup(group));
});

export const PATCH = scimHandler("groups.patch", async (req, ctx: Context) => {
  const operations = parseScimGroupPatch(await readJsonOr(req, null));
  const group = await patchScimGroup((await ctx.params).id, operations, clientIp(req.headers) || null);
  return scimJson(toScimGroup(group));
});

export const DELETE = scimHandler("groups.delete", async (req, ctx: Context) => {
  await deleteScimGroup((await ctx.params).id, clientIp(req.headers) || null);
  return new Response(null, { status: 204 });
});
