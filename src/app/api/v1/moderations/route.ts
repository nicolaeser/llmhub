import { NextResponse } from "next/server";
import { modelChain } from "@/lib/gateway/access/gate";
import { gatewayRoute, screenModelRequest } from "@/lib/gateway/endpoints/pipeline";
import { meter } from "@/lib/gateway/billing/meter";
import { forwardToModel } from "@/lib/gateway/dispatch/upstream";

export const POST = gatewayRoute(async (req) => {
  const { principal, model, body, clean } = await screenModelRequest(req);
  const aliases = modelChain(principal, model, clean);
  const usage = meter(principal, model, body);
  try {
    const hit = await forwardToModel(aliases, principal, "/moderations", clean);
    await usage.ok(hit);
    return NextResponse.json(hit.json);
  } catch (err) {
    await usage.fail(err);
    throw err;
  }
});
