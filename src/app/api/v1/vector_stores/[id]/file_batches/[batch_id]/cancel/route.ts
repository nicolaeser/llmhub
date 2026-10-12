import { NextResponse } from "next/server";
import { gateRequest, gateResponse } from "@/lib/gateway/gate";
import { batchJson, cancelBatch, writableStore } from "@/lib/rag/stores";

export async function POST(req: Request, ctx: { params: Promise<{ id: string; batch_id: string }> }) {
  try {
    const principal = await gateRequest(req);
    const { id, batch_id } = await ctx.params;
    const store = await writableStore(principal, id);
    await batchJson(store.id, batch_id);
    await cancelBatch(store.id, batch_id);
    return NextResponse.json(await batchJson(store.id, batch_id));
  } catch (err) {
    return gateResponse(err, req);
  }
}
