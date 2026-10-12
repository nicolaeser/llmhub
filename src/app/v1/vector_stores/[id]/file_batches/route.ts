import { NextResponse } from "next/server";
import { gateRequest, gateResponse } from "@/lib/gateway/gate";
import { attachFor, batchRequests, parseBody } from "@/lib/rag/api";
import { batchJson, newBatchId, usableStore, writableStore } from "@/lib/rag/stores";
import { fileBatchSchema } from "@/schemas/rag";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const principal = await gateRequest(req);
    const { id } = await ctx.params;
    const store = usableStore(await writableStore(principal, id));
    const body = await parseBody(req, fileBatchSchema);
    const batchId = newBatchId();
    await attachFor(principal, store, batchRequests(store, body), batchId);
    return NextResponse.json(await batchJson(store.id, batchId));
  } catch (err) {
    return gateResponse(err, req);
  }
}
