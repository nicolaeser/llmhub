import { NextResponse } from "next/server";
import { gateRequest, gateResponse } from "@/lib/gateway/gate";
import { createStoreFor, parseBody } from "@/lib/rag/api";
import { listQuery, listStores } from "@/lib/rag/stores";
import { createVectorStoreSchema } from "@/schemas/rag";

export async function GET(req: Request) {
  try {
    const principal = await gateRequest(req);
    return NextResponse.json(await listStores(principal, listQuery(new URL(req.url))));
  } catch (err) {
    return gateResponse(err, req);
  }
}

export async function POST(req: Request) {
  try {
    const principal = await gateRequest(req);
    const body = await parseBody(req, createVectorStoreSchema);
    return NextResponse.json(await createStoreFor(principal, body));
  } catch (err) {
    return gateResponse(err, req);
  }
}
