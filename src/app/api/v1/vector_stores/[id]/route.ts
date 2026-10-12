import { NextResponse } from "next/server";
import { allowModel, gateRequest, gateResponse } from "@/lib/gateway/gate";
import { asStringMap } from "@/lib/gateway/core";
import { parseBody } from "@/lib/rag/api";
import {
  deleteVectorStore,
  readableStore,
  storesJson,
  updateVectorStore,
  writableStore,
} from "@/lib/rag/stores";
import { updateVectorStoreSchema } from "@/schemas/rag";

type Context = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Context) {
  try {
    const principal = await gateRequest(req);
    const { id } = await ctx.params;
    const [json] = await storesJson([await readableStore(principal, id)]);
    return NextResponse.json(json);
  } catch (err) {
    return gateResponse(err, req);
  }
}

export async function POST(req: Request, ctx: Context) {
  try {
    const principal = await gateRequest(req);
    const { id } = await ctx.params;
    const store = await writableStore(principal, id);
    const body = await parseBody(req, updateVectorStoreSchema);
    for (const model of [body.rerank_model, body.ocr_model]) if (model) allowModel(principal, model);
    const updated = await updateVectorStore(store, {
      name: body.name ?? undefined,
      description: body.description ?? undefined,
      metadata: body.metadata ? asStringMap(body.metadata) : undefined,
      expiresAfterDays: body.expires_after === undefined ? undefined : (body.expires_after?.days ?? null),
      rerankModel: body.rerank_model ?? undefined,
      ocrModel: body.ocr_model ?? undefined,
    });
    const [json] = await storesJson([updated]);
    return NextResponse.json(json);
  } catch (err) {
    return gateResponse(err, req);
  }
}

export async function DELETE(req: Request, ctx: Context) {
  try {
    const principal = await gateRequest(req);
    const { id } = await ctx.params;
    const store = await writableStore(principal, id);
    await deleteVectorStore(store.id);
    return NextResponse.json({ id: store.id, object: "vector_store.deleted", deleted: true });
  } catch (err) {
    return gateResponse(err, req);
  }
}
