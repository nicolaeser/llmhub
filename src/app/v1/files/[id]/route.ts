import { NextResponse } from "next/server";
import { gateRequest, gateResponse } from "@/lib/gateway/gate";
import { GateError } from "@/lib/gateway/errors";
import { canReadObject, deleteObject, fileJson, getObject } from "@/lib/gateway/objects";
import { ownerId } from "@/lib/gateway/core";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const principal = await gateRequest(req);
    const { id } = await ctx.params;
    const object = await getObject(id);
    if (!object || object.kind !== "file" || !canReadObject(object, principal)) {
      throw new GateError(404, "not_found", "file not found", { param: "id" });
    }
    return NextResponse.json(fileJson(object));
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
    const object = await getObject(id);
    if (!object || object.kind !== "file" || !canReadObject(object, principal)) {
      throw new GateError(404, "not_found", "file not found", { param: "id" });
    }
    await deleteObject(id, ownerId(principal));
    return NextResponse.json({ id, object: "file", deleted: true });
  } catch (err) {
    return gateResponse(err, req);
  }
}
