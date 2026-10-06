import { NextResponse } from "next/server";
import { cancelBatch } from "@/lib/gateway/batches";
import { gateRequest, gateResponse } from "@/lib/gateway/gate";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const principal = await gateRequest(req);
    const { id } = await ctx.params;
    return NextResponse.json(await cancelBatch(principal, id));
  } catch (err) {
    return gateResponse(err, req);
  }
}
