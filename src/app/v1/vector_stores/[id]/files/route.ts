import { NextResponse } from "next/server";
import { gateRequest, gateResponse } from "@/lib/gateway/gate";
import { attachFor, attachRequest, parseBody } from "@/lib/rag/api";
import { fileJson, listQuery, listStoreFiles, readableStore, usableStore, writableStore } from "@/lib/rag/stores";
import { attachFileSchema } from "@/schemas/rag";

type Context = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Context) {
  try {
    const principal = await gateRequest(req);
    const { id } = await ctx.params;
    const store = await readableStore(principal, id);
    const url = new URL(req.url);
    return NextResponse.json(
      await listStoreFiles(store.id, { ...listQuery(url), status: url.searchParams.get("filter") || null }),
    );
  } catch (err) {
    return gateResponse(err, req);
  }
}

export async function POST(req: Request, ctx: Context) {
  try {
    const principal = await gateRequest(req);
    const { id } = await ctx.params;
    const store = usableStore(await writableStore(principal, id));
    const body = await parseBody(req, attachFileSchema);
    const [row] = await attachFor(principal, store, [attachRequest(store, body)], "");
    return NextResponse.json(fileJson(row!));
  } catch (err) {
    return gateResponse(err, req);
  }
}
