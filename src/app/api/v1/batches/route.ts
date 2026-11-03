import { after, NextResponse } from "next/server";
import { createBatch, listBatches, startBatch } from "@/lib/gateway/endpoints/batches";
import { gateRequest, gateResponse, readBody } from "@/lib/gateway/access/gate";
import { idempotent, jsonFingerprint } from "@/lib/gateway/storage/idempotency";

export async function GET(req: Request) {
  try {
    const principal = await gateRequest(req);
    const query = new URL(req.url).searchParams;
    return NextResponse.json(await listBatches(principal, { after: query.get("after"), limit: query.get("limit") }));
  } catch (err) {
    return gateResponse(err, req);
  }
}

export async function POST(req: Request) {
  try {
    const principal = await gateRequest(req);
    const body = await readBody(req);
    return await idempotent({ req, principal, fingerprint: () => jsonFingerprint(req, body) }, async () => {
      const batch = await createBatch(principal, body);
      if (batch.status === "validating") after(() => startBatch(String(batch.id)));
      return NextResponse.json(batch);
    });
  } catch (err) {
    return gateResponse(err, req);
  }
}
