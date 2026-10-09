import { NextResponse } from "next/server";
import { usageFromUnknown } from "@/lib/gateway/billing";
import { asRecord } from "@/lib/gateway/core";
import { allowModel, applyPii, gateRequest, gateResponse, modelChain, modelOf, readBody } from "@/lib/gateway/gate";
import { GateError } from "@/lib/gateway/errors";
import { meter } from "@/lib/gateway/meter";
import { parseRequest } from "@/lib/gateway/responses";
import { forwardToModel } from "@/lib/gateway/upstream";
import { systemOneRequestSchema } from "@/schemas/decisions";

export async function POST(req: Request) {
  try {
    const principal = await gateRequest(req);
    const body = await readBody(req);
    const model = modelOf(body);
    allowModel(principal, model);
    const { body: clean } = await applyPii(body, principal);
    const aliases = modelChain(principal, model, clean);
    const parsed = parseRequest(systemOneRequestSchema, clean);
    if (!parsed.ok) {
      throw new GateError(422, "invalid_request", parsed.message, { param: parsed.param });
    }
    const usage = meter(principal, model, clean);
    try {
      const hit = await forwardToModel(aliases, principal, "/systemone", clean);
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
