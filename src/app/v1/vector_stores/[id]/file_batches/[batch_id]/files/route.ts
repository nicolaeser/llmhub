import { NextResponse } from "next/server";
import { gateRequest, gateResponse } from "@/lib/gateway/gate";
import { batchJson, listQuery, listStoreFiles, readableStore } from "@/lib/rag/stores";

export async function GET(req: Request, ctx: { params: Promise<{ id: string; batch_id: string }> }) {
  try {
    const principal = await gateRequest(req);
    const { id, batch_id } = await ctx.params;
    const store = await readableStore(principal, id);
    await batchJson(store.id, batch_id);
    const url = new URL(req.url);
    return NextResponse.json(
      await listStoreFiles(store.id, {
        ...listQuery(url),
        status: url.searchParams.get("filter") || null,
        batchId: batch_id,
      }),
    );
  } catch (err) {
    return gateResponse(err, req);
  }
}
