import { NextResponse } from "next/server";
import { ownerId } from "@/lib/gateway/core";
import { gateRequest, gateResponse } from "@/lib/gateway/gate";
import { deleteObject } from "@/lib/gateway/objects";
import { forwardToModel } from "@/lib/gateway/upstream";
import { refreshVideo, videoRecord } from "@/lib/gateway/videos";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const principal = await gateRequest(req);
    const { id } = await ctx.params;
    const { model, upstreamId } = await videoRecord(principal, id);
    const hit = await forwardToModel([model], principal, `/videos/${upstreamId}`, null, { method: "GET" });
    return NextResponse.json(await refreshVideo(id, hit.json));
  } catch (err) {
    return gateResponse(err, req);
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const principal = await gateRequest(req);
    const { id } = await ctx.params;
    const { model, upstreamId } = await videoRecord(principal, id);
    await forwardToModel([model], principal, `/videos/${upstreamId}`, null, { method: "DELETE" }).catch(() => null);
    await deleteObject(id, ownerId(principal));
    return NextResponse.json({ id, object: "video", deleted: true });
  } catch (err) {
    return gateResponse(err, req);
  }
}
