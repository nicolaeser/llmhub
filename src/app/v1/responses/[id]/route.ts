import { NextResponse } from "next/server";
import { gateRequest, gateResponse } from "@/lib/gateway/gate";
import { GateError } from "@/lib/gateway/errors";
import { deleteObject } from "@/lib/gateway/objects";
import { responseId, visibleResponse } from "@/lib/gateway/responses";
import { findStoredResponse, loadStoredResponse } from "@/lib/gateway/responses-store";
import { ownerId } from "@/lib/gateway/core";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const principal = await gateRequest(req);
    const { id } = await ctx.params;
    const stored = await loadStoredResponse(id, principal);
    const include = new URL(req.url).searchParams.getAll("include[]");
    return NextResponse.json(visibleResponse(stored.response, include));
  } catch (err) {
    return gateResponse(err, req);
  }
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const principal = await gateRequest(req);
    const { id } = await ctx.params;
    const object = await findStoredResponse(id, principal);
    const deleted = await deleteObject(object.id, ownerId(principal));
    if (!deleted) {
      throw new GateError(404, "not_found", "response not found", { param: "id" });
    }
    return NextResponse.json({ id: responseId(object.id), object: "response.deleted", deleted: true });
  } catch (err) {
    return gateResponse(err, req);
  }
}
