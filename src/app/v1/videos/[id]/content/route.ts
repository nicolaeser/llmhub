import { gateRequest, gateResponse } from "@/lib/gateway/gate";
import { bytesBody } from "@/lib/http/api";
import { forwardToModel } from "@/lib/gateway/upstream";
import { videoRecord } from "@/lib/gateway/videos";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const principal = await gateRequest(req);
    const { id } = await ctx.params;
    const { model, upstreamId } = await videoRecord(principal, id);
    const variant = new URL(req.url).searchParams.get("variant");
    const path = `/videos/${upstreamId}/content${variant ? `?variant=${encodeURIComponent(variant)}` : ""}`;
    const hit = await forwardToModel([model], path, null, { method: "GET", binary: true });
    return new Response(bytesBody(hit.raw), {
      status: hit.status,
      headers: { "Content-Type": hit.contentType },
    });
  } catch (err) {
    return gateResponse(err, req);
  }
}
