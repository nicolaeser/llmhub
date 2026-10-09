import "server-only";
import { NextResponse } from "next/server";
import { gateRequest, gateResponse, modelPermitted } from "@/lib/gateway/gate";
import { GateError } from "@/lib/gateway/errors";
import { apiKeyRequest } from "@/lib/gateway/messages";
import { AUTO_MODEL, modelEntry } from "@/lib/gateway/core";
import { modelAlias } from "@/lib/gateway/model-alias";
import { pricedModels } from "@/lib/gateway/model-pricing";
import { listedIn } from "@/lib/gateway/route-pool";
import type { RoutePool } from "@/types/gateway";

export function listModelsRoute(pool: RoutePool) {
  return async (req: Request): Promise<Response> => {
    try {
      const principal = await gateRequest(apiKeyRequest(req), pool);
      const created = new Date();
      const models = [...(await pricedModels(created)), AUTO_MODEL];
      const data = models
        .filter((model) => modelPermitted(principal, model.alias) && listedIn(model, pool))
        .map((model) => modelEntry(model.alias, created, model.pricing, model));
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
  };
}

export function retrieveModelRoute(pool: RoutePool) {
  return async (req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> => {
    try {
      const principal = await gateRequest(apiKeyRequest(req), pool);
      const id = modelAlias((await ctx.params).id);
      const created = new Date();
      const model = id === AUTO_MODEL.alias ? AUTO_MODEL : (await pricedModels(created, [id]))[0];
      if (!model || !modelPermitted(principal, id) || !listedIn(model, pool)) {
        throw new GateError(404, "model_not_found", "model not found", { param: "id" });
      }
      return NextResponse.json(modelEntry(id, created, model.pricing, model));
    } catch (err) {
      return gateResponse(err, req);
    }
  };
}
