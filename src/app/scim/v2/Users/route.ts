import {
  createScimUser,
  listScimUsers,
  parseScimFilter,
  parseScimUserBody,
  requireScimToken,
  scimCaught,
  scimJson,
  toScimUser,
  SCIM_LIST_SCHEMA,
} from "@/lib/gateway/scim";
import { logger } from "@/lib/logging/logger";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    await requireScimToken(req);
    const url = new URL(req.url);
    const filter = parseScimFilter(url.searchParams.get("filter"));
    const users = await listScimUsers(filter);
    const startIndex = Math.max(1, Number(url.searchParams.get("startIndex") ?? 1) || 1);
    const countRaw = Number(url.searchParams.get("count") ?? users.length);
    const count = Number.isFinite(countRaw)
      ? Math.min(Math.max(countRaw, 0), 200)
      : users.length;
    const slice = users.slice(startIndex - 1, startIndex - 1 + count);
    return scimJson({
      schemas: [SCIM_LIST_SCHEMA],
      totalResults: users.length,
      startIndex,
      itemsPerPage: slice.length,
      Resources: slice.map(toScimUser),
    });
  } catch (err) {
    if (((err as { status?: number }).status ?? 500) >= 500) {
      logger.error("scim.list.failed", { err: String(err) });
    }
    return scimCaught(err);
  }
}

export async function POST(req: Request) {
  try {
    await requireScimToken(req);
    const body = parseScimUserBody(await req.json().catch(() => null));
    const user = await createScimUser(body);
    return scimJson(toScimUser(user), 201);
  } catch (err) {
    if (((err as { status?: number }).status ?? 500) >= 500) {
      logger.error("scim.create.failed", { err: String(err) });
    }
    return scimCaught(err);
  }
}
