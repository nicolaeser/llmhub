import { NextResponse } from "next/server";
import { usageFromUnknown } from "@/lib/gateway/billing";
import { asRecord } from "@/lib/gateway/core";
import { allowModel, applyGuardrails, gateRequest, gateResponse, modelOf, modelChain } from "@/lib/gateway/gate";
import { streamMedia, wantsStream } from "@/lib/gateway/media-stream";
import { meter } from "@/lib/gateway/meter";
import { readModelRequest } from "@/lib/gateway/multipart";
import { forwardToModel } from "@/lib/gateway/upstream";

export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const principal = await gateRequest(req);
    const { body, rawBody, contentType } = await readModelRequest(req);
    const model = modelOf(body);
    allowModel(principal, model);
    const clean = rawBody ? body : (await applyGuardrails(body, principal)).body;
    const aliases = modelChain(principal, model, clean);
    if (wantsStream(clean)) {
      return await streamMedia({
        req,
        principal,
        model,
        aliases,
        path: "/images/generations",
        body: clean,
        form: rawBody,
      });
    }
    const usage = meter(principal, model, body);
    try {
      const hit = await forwardToModel(aliases, principal, "/images/generations", rawBody ? null : clean, {
        rawBody,
        contentType: rawBody ? undefined : contentType,
      });
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
