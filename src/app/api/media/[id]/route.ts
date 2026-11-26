import { gateResponse } from "@/lib/gateway/access/gate";
import { GateError } from "@/lib/gateway/errors";
import { getObject } from "@/lib/gateway/storage/objects";
import { bytesBody } from "@/lib/http/api";
import { isMediaObject, mediaLinkValid, mediaRange } from "@/lib/mcp/media";

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
    const headers = {
      "Content-Type": object.contentType || "application/octet-stream",
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Disposition": `inline; filename="${object.filename.replace(/[^\w.-]/g, "_") || "media"}"`,
      "Accept-Ranges": "bytes",
    };
    const size = object.payload.byteLength;
    const range = mediaRange(req.headers.get("range"), size);
    if (range === "unsatisfiable") {
      return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
    }
    if (range) {
      return new Response(bytesBody(object.payload.subarray(range.start, range.end + 1)), {
        status: 206,
        headers: { ...headers, "Content-Range": `bytes ${range.start}-${range.end}/${size}` },
      });
    }
    return new Response(bytesBody(object.payload), { headers });
  } catch (err) {
    return gateResponse(err, req);
  }
}
