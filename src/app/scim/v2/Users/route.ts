import {
  createScimUser,
  listScimUsers,
  parseScimPage,
  parseScimUserBody,
  scimHandler,
  scimJson,
  scimList,
  toScimUser,
} from "@/lib/auth/scim";
import { readJsonOr } from "@/lib/utils/json";

export const dynamic = "force-dynamic";

export const GET = scimHandler("list", async (req) => {
  const url = new URL(req.url);
  const page = parseScimPage(url);
  const { total, users } = await listScimUsers(url.searchParams.get("filter"), page);
  return scimJson(scimList(users.map(toScimUser), total, page));
});

export const POST = scimHandler("create", async (req) => {
  const user = await createScimUser(parseScimUserBody(await readJsonOr(req, null)));
  return scimJson(toScimUser(user), 201);
});
