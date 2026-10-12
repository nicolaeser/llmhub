import { NextResponse } from "next/server";
import { gateRequest, gateResponse } from "@/lib/gateway/gate";
import { fileChunksJson, readableStore, storeFile } from "@/lib/rag/stores";

export async function GET(req: Request, ctx: { params: Promise<{ id: string; file_id: string }> }) {
  try {
    const principal = await gateRequest(req);
    const { id, file_id } = await ctx.params;
    const store = await readableStore(principal, id);
    return NextResponse.json(await fileChunksJson(await storeFile(store.id, file_id)));
  } catch (err) {
    return gateResponse(err, req);
  }
}
