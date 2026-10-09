import { NextResponse } from "next/server";
import { gateRequest, gateResponse } from "@/lib/gateway/gate";
import { parseBody } from "@/lib/rag/api";
import {
  detachFile,
  fileJson,
  readableStore,
  storeFile,
  updateFileAttributes,
  writableStore,
} from "@/lib/rag/stores";
import { updateFileSchema } from "@/schemas/rag";

type Context = { params: Promise<{ id: string; file_id: string }> };

export async function GET(req: Request, ctx: Context) {
  try {
    const principal = await gateRequest(req);
    const { id, file_id } = await ctx.params;
    const store = await readableStore(principal, id);
    return NextResponse.json(fileJson(await storeFile(store.id, file_id)));
  } catch (err) {
    return gateResponse(err, req);
  }
}

export async function POST(req: Request, ctx: Context) {
  try {
    const principal = await gateRequest(req);
    const { id, file_id } = await ctx.params;
    const store = await writableStore(principal, id);
    const row = await storeFile(store.id, file_id);
    const body = await parseBody(req, updateFileSchema);
    return NextResponse.json(fileJson(await updateFileAttributes(row, body.attributes ?? {})));
  } catch (err) {
    return gateResponse(err, req);
  }
}

export async function DELETE(req: Request, ctx: Context) {
  try {
    const principal = await gateRequest(req);
    const { id, file_id } = await ctx.params;
    const store = await writableStore(principal, id);
    const row = await storeFile(store.id, file_id);
    await detachFile(store.id, row.fileId);
    return NextResponse.json({ id: row.fileId, object: "vector_store.file.deleted", deleted: true });
  } catch (err) {
    return gateResponse(err, req);
  }
}
