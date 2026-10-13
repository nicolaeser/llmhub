import { NextResponse } from "next/server";
import { usageFromUnknown } from "@/lib/gateway/billing/billing";
import { asRecord } from "@/lib/gateway/core";
import { resolveImageFiles } from "@/lib/gateway/storage/file-refs";
import { allowModel, applyGuardrails, gateRequest, gateResponse, modelOf, modelChain } from "@/lib/gateway/access/gate";
import { streamMedia, wantsStream } from "@/lib/gateway/endpoints/media-stream";
import { meter } from "@/lib/gateway/billing/meter";
import { readModelRequest } from "@/lib/gateway/endpoints/multipart";
import { forwardToModel } from "@/lib/gateway/dispatch/upstream";

export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const principal = await gateRequest(req);
    const { body, rawBody, contentType } = await readModelRequest(req);
    const model = modelOf(body);
    allowModel(principal, model);
    const clean = rawBody ? body : await resolveImageFiles((await applyGuardrails(body, principal)).body, principal);
    const aliases = modelChain(principal, model, clean);
    if (wantsStream(clean)) {
      return await streamMedia({
        req,
        principal,
        model,
        aliases,
        path: "/images/edits",
        body: clean,
        form: rawBody,
      });
    }
    const usage = meter(principal, model, body);
    try {
      const hit = await forwardToModel(aliases, principal, "/images/edits", rawBody ? null : clean, {
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
