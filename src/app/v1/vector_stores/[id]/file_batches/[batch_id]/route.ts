import { NextResponse } from "next/server";
import { gateRequest, gateResponse } from "@/lib/gateway/gate";
import { batchJson, readableStore } from "@/lib/rag/stores";

export async function GET(req: Request, ctx: { params: Promise<{ id: string; batch_id: string }> }) {
  try {
    const principal = await gateRequest(req);
    const { id, batch_id } = await ctx.params;
    const store = await readableStore(principal, id);
    return NextResponse.json(await batchJson(store.id, batch_id));
  } catch (err) {
    return gateResponse(err, req);
  }
}
