import { NextResponse } from "next/server";
import { usageFromUnknown } from "@/lib/gateway/billing";
import { asRecord } from "@/lib/gateway/core";
import { allowModel, gateRequest, gateResponse, modelOf, modelChain } from "@/lib/gateway/gate";
import { meter } from "@/lib/gateway/meter";
import { readModelRequest } from "@/lib/gateway/multipart";
import { forwardToModel } from "@/lib/gateway/upstream";

export async function POST(req: Request) {
  try {
    const principal = await gateRequest(req);
    const { body, rawBody, contentType } = await readModelRequest(req);
    const model = modelOf(body);
    allowModel(principal, model);
    const aliases = modelChain(principal, model, {});
    const usage = meter(principal, model, body);
    try {
      const hit = await forwardToModel(aliases, principal, "/audio/translations", rawBody ? null : body, {
        rawBody,
        contentType: rawBody ? undefined : contentType,
        binary: true,
      });
      const text = new TextDecoder().decode(hit.raw);
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {}
      await usage.ok(hit, usageFromUnknown(asRecord(json)?.usage, json), json ?? text);
      return json === null
        ? new Response(text, { status: hit.status, headers: { "Content-Type": hit.contentType } })
        : NextResponse.json(json, { status: hit.status });
    } catch (err) {
      await usage.fail(err);
      throw err;
    }
  } catch (err) {
    return gateResponse(err, req);
  }
}
