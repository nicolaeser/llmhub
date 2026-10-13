import {
  deleteScimUser,
  getScimUser,
  parseScimPatch,
  parseScimPut,
  requireScimToken,
  scimCaught,
  scimError,
  scimJson,
  toScimUser,
  updateScimUser,
} from "@/lib/auth/scim";
import { clientIp } from "@/lib/http/api";
import { logger } from "@/lib/logging/logger";
import { readJsonOr } from "@/lib/utils/json";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    await requireScimToken(req);
    const { id } = await ctx.params;
    const user = await getScimUser(id);
    if (!user) return scimError(404, "not found");
    return scimJson(toScimUser(user));
  } catch (err) {
    if (((err as { status?: number }).status ?? 500) >= 500) {
      logger.error("scim.get.failed", { err: String(err) });
    }
    return scimCaught(err);
  }
}

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    await requireScimToken(req);
    const { id } = await ctx.params;
    const operations = parseScimPut(await readJsonOr(req, null));
    const user = await updateScimUser(id, operations, clientIp(req.headers) || null);
    return scimJson(toScimUser(user));
  } catch (err) {
    if (((err as { status?: number }).status ?? 500) >= 500) {
      logger.error("scim.replace.failed", { err: String(err) });
    }
    return scimCaught(err);
  }
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    await requireScimToken(req);
    const { id } = await ctx.params;
    const operations = parseScimPatch(await readJsonOr(req, null));
    const user = await updateScimUser(id, operations, clientIp(req.headers) || null);
    return scimJson(toScimUser(user));
  } catch (err) {
    if (((err as { status?: number }).status ?? 500) >= 500) {
      logger.error("scim.patch.failed", { err: String(err) });
    }
    return scimCaught(err);
  }
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    await requireScimToken(req);
    const { id } = await ctx.params;
    await deleteScimUser(id);
    return new Response(null, { status: 204 });
  } catch (err) {
    if (((err as { status?: number }).status ?? 500) >= 500) {
      logger.error("scim.delete.failed", { err: String(err) });
    }
    return scimCaught(err);
  }
}
