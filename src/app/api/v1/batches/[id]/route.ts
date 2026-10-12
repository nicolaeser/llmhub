import { NextResponse } from "next/server";
import { gateRequest, gateResponse } from "@/lib/gateway/gate";
import { GateError } from "@/lib/gateway/errors";
import { canReadObject, getObject, payloadJson } from "@/lib/gateway/objects";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const principal = await gateRequest(req);
    const { id } = await ctx.params;
    const object = await getObject(id);
    if (!object || object.kind !== "batch" || !canReadObject(object, principal)) {
      throw new GateError(404, "not_found", "batch not found", { param: "id" });
    }
    return NextResponse.json(payloadJson(object));
  } catch (err) {
    return gateResponse(err, req);
  }
}
