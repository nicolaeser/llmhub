import { NextResponse } from "next/server";
import { gateRequest, gateResponse, modelPermitted } from "@/lib/gateway/gate";
import { GateError } from "@/lib/gateway/errors";
import { apiKeyRequest } from "@/lib/gateway/messages";
import { AUTO_MODEL, modelEntry } from "@/lib/gateway/core";
import { modelAlias } from "@/lib/gateway/model-alias";
import { pricedModels } from "@/lib/gateway/model-pricing";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const principal = await gateRequest(apiKeyRequest(req));
    const id = modelAlias((await ctx.params).id);
    const created = new Date();
    const model = id === AUTO_MODEL.alias ? AUTO_MODEL : (await pricedModels(created, [id]))[0];
    if (!model || !modelPermitted(principal, id)) {
      throw new GateError(404, "model_not_found", "model not found", { param: "id" });
    }
    return NextResponse.json(modelEntry(id, created, model.pricing, model));
  } catch (err) {
    return gateResponse(err, req);
  }
}
