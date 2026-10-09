import { NextResponse } from "next/server";
import { usageFromUnknown } from "@/lib/gateway/billing";
import { asRecord } from "@/lib/gateway/core";
import { allowModel, applyGuardrails, gateRequest, gateResponse, readBody } from "@/lib/gateway/gate";
import { meter } from "@/lib/gateway/meter";
import { forwardToModel } from "@/lib/gateway/upstream";
import { storeVideo, videoRecord } from "@/lib/gateway/videos";

export const maxDuration = 300;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const principal = await gateRequest(req);
    const { id } = await ctx.params;
    const { model, upstreamId } = await videoRecord(principal, id);
    allowModel(principal, model);
    const { body: clean } = await applyGuardrails(await readBody(req), principal);
    const usage = meter(principal, model, clean);
    try {
      const hit = await forwardToModel([model], principal, `/videos/${upstreamId}/remix`, clean);
      await usage.ok(hit, usageFromUnknown(asRecord(hit.json)?.usage, hit.json));
      return NextResponse.json(await storeVideo(principal, model, hit.json));
    } catch (err) {
      await usage.fail(err);
      throw err;
    }
  } catch (err) {
    return gateResponse(err, req);
  }
}
