import { NextResponse } from "next/server";
import { usageFromUnknown } from "@/lib/gateway/billing/billing";
import { asRecord } from "@/lib/gateway/core";
import { modelChain } from "@/lib/gateway/access/gate";
import { gatewayRoute, screenModelRequest, validRequest } from "@/lib/gateway/endpoints/pipeline";
import { meter } from "@/lib/gateway/billing/meter";
import { forwardToModel } from "@/lib/gateway/dispatch/upstream";
import { systemOneRequestSchema } from "@/schemas/decisions";

const TYPESAFE_VALIDATION_STATUS = 422;

export const POST = gatewayRoute(async (req) => {
  const { principal, model, clean } = await screenModelRequest(req);
  const aliases = modelChain(principal, model, clean);
  validRequest(systemOneRequestSchema, clean, TYPESAFE_VALIDATION_STATUS);
  const usage = meter(principal, model, clean);
  try {
    const hit = await forwardToModel(aliases, principal, "/systemone", clean);
    await usage.ok(hit, usageFromUnknown(asRecord(hit.json)?.usage, hit.json));
    return NextResponse.json(hit.json);
  } catch (err) {
    await usage.fail(err);
    throw err;
  }
});
