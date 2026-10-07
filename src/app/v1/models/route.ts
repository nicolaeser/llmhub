import { NextResponse } from "next/server";
import { gateRequest, gateResponse, modelPermitted } from "@/lib/gateway/gate";
import { apiKeyRequest } from "@/lib/gateway/messages";
import { modelEntry } from "@/lib/gateway/core";
import { pricedModels } from "@/lib/gateway/model-pricing";

export async function GET(req: Request) {
  try {
    const principal = await gateRequest(apiKeyRequest(req));
    const created = new Date();
    const models = [...(await pricedModels(created)), { alias: "auto", pricing: null }];
    const data = models
      .filter((model) => modelPermitted(principal, model.alias))
      .map((model) => modelEntry(model.alias, created, model.pricing));
    return NextResponse.json({
      object: "list",
      data,
      has_more: false,
      first_id: data[0]?.id ?? null,
      last_id: data.at(-1)?.id ?? null,
    });
  } catch (err) {
    return gateResponse(err, req);
  }
}
