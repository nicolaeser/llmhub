import {
  deleteScimUser,
  getScimUser,
  parseScimPatch,
  parseScimPut,
  scimError,
  scimHandler,
  scimJson,
  toScimUser,
  updateScimUser,
} from "@/lib/auth/scim";
import { clientIp } from "@/lib/http/api";
import { readJsonOr } from "@/lib/utils/json";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export const GET = scimHandler("get", async (_req, ctx: Context) => {
  const user = await getScimUser((await ctx.params).id);
  if (!user) return scimError(404, "not found");
  return scimJson(toScimUser(user));
});

export const PUT = scimHandler("replace", async (req, ctx: Context) => {
  const operations = parseScimPut(await readJsonOr(req, null));
  const user = await updateScimUser((await ctx.params).id, operations, clientIp(req.headers) || null);
  return scimJson(toScimUser(user));
});

export const PATCH = scimHandler("patch", async (req, ctx: Context) => {
  const operations = parseScimPatch(await readJsonOr(req, null));
  const user = await updateScimUser((await ctx.params).id, operations, clientIp(req.headers) || null);
  return scimJson(toScimUser(user));
});

export const DELETE = scimHandler("delete", async (_req, ctx: Context) => {
  await deleteScimUser((await ctx.params).id);
  return new Response(null, { status: 204 });
});
