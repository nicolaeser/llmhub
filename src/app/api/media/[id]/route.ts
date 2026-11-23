import { gateResponse } from "@/lib/gateway/access/gate";
import { GateError } from "@/lib/gateway/errors";
import { getObject } from "@/lib/gateway/storage/objects";
import { bytesBody } from "@/lib/http/api";
import { isMediaObject, mediaLinkValid } from "@/lib/mcp/media";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const query = new URL(req.url).searchParams;
    if (!mediaLinkValid(id, query.get("expires"), query.get("signature"))) {
      throw new GateError(403, "permission_denied", "this link is invalid or has expired");
    }
    const object = await getObject(id);
    if (!object || object.kind !== "file" || !isMediaObject(object.meta, object.purpose)) {
      throw new GateError(404, "not_found", "file not found", { param: "id" });
    }
    return new Response(bytesBody(object.payload), {
      headers: {
        "Content-Type": object.contentType || "application/octet-stream",
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Disposition": `inline; filename="${object.filename.replace(/[^\w.-]/g, "_") || "media"}"`,
      },
    });
  } catch (err) {
    return gateResponse(err, req);
  }
}
