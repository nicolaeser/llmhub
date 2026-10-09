import { NextResponse } from "next/server";
import { usageFromUnknown } from "@/lib/gateway/billing";
import { asRecord } from "@/lib/gateway/core";
import { allowModel, applyPii, gateRequest, gateResponse, modelOf, readBody, modelChain } from "@/lib/gateway/gate";
import { meter } from "@/lib/gateway/meter";
import { forwardToModel } from "@/lib/gateway/upstream";

export async function POST(req: Request) {
  try {
    const principal = await gateRequest(req);
    const body = await readBody(req);
    const model = modelOf(body);
    allowModel(principal, model);
    const { body: clean } = await applyPii(body, principal);
    const aliases = modelChain(principal, model, clean);
    const usage = meter(principal, model, body);
    try {
      const hit = await forwardToModel(aliases, principal, "/embeddings", clean);
      await usage.ok(hit, usageFromUnknown(asRecord(hit.json)?.usage, hit.json));
      return NextResponse.json(hit.json);
    } catch (err) {
      await usage.fail(err);
      throw err;
    }
  } catch (err) {
    return gateResponse(err, req);
  }
}
