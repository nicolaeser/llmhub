import { NextResponse } from "next/server";
import { usageFromUnknown } from "@/lib/gateway/billing/billing";
import { asRecord } from "@/lib/gateway/core";
import { modelChain } from "@/lib/gateway/access/gate";
import { gatewayRoute, screenModelRequest } from "@/lib/gateway/endpoints/pipeline";
import { meter } from "@/lib/gateway/billing/meter";
import { forwardToModel } from "@/lib/gateway/dispatch/upstream";

export const POST = gatewayRoute(async (req) => {
  const { principal, model, body, clean } = await screenModelRequest(req);
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
});
