import { gateRequest, gateResponse } from "@/lib/gateway/gate";
import { GateError } from "@/lib/gateway/errors";
import { canReadObject, getObject } from "@/lib/gateway/objects";
import { bytesBody } from "@/lib/http/api";

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
    return new Response(bytesBody(object.payload), {
      headers: { "Content-Type": object.contentType || "application/octet-stream" },
    });
  } catch (err) {
    return gateResponse(err, req);
  }
}
