import "server-only";
import { NextResponse } from "next/server";
import { gateRequest, gateResponse, modelPermitted } from "@/lib/gateway/gate";
import { GateError } from "@/lib/gateway/errors";
import { apiKeyRequest } from "@/lib/gateway/messages";
import { AUTO_MODEL, modelEntry } from "@/lib/gateway/core";
import { API_ROUTE_PREFIX, modelAlias } from "@/lib/gateway/model-alias";
import { pricedModels } from "@/lib/gateway/model-pricing";
import { listedIn, routeOf } from "@/lib/gateway/route-pool";
import type { JsonMap, PublicModel, RoutePool } from "@/types/gateway";

function apiEntry(model: PublicModel, created: Date) {
  const label = `${model.displayName || model.alias} (API)`;
  return modelEntry(`${API_ROUTE_PREFIX}${model.alias}`, created, model.pricing, { ...model, displayName: label }, "api");
}

export function modelEntries(
  models: PublicModel[],
  pool: RoutePool,
  allowed: (alias: string) => boolean,
  created: Date,
): JsonMap[] {
  const permitted = models.filter((model) => allowed(model.alias));
  const own = permitted
    .filter((model) => listedIn(model, pool))
    .map((model) =>
      pool === "subscription"
        ? modelEntry(model.alias, created, model.subscriptionPricing, model, "subscription")
        : modelEntry(model.alias, created, model.pricing, model),
    );
  const viaApi =
    pool === "subscription" ? permitted.filter((model) => listedIn(model, "api")).map((model) => apiEntry(model, created)) : [];
  return [...own, ...viaApi];
}

export function listModelsRoute(pool: RoutePool) {
  return async (req: Request): Promise<Response> => {
    try {
      const principal = await gateRequest(apiKeyRequest(req), pool);
      const created = new Date();
      const models = [...(await pricedModels(created)), AUTO_MODEL];
      const data = modelEntries(models, pool, (alias) => modelPermitted(principal, alias), created);
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
      const requested = modelAlias((await ctx.params).id);
      const route = routeOf(requested, pool);
      const id = route.alias;
      const created = new Date();
      const model = id === AUTO_MODEL.alias ? AUTO_MODEL : (await pricedModels(created, [id]))[0];
      if (!model || !modelPermitted(principal, requested) || !listedIn(model, route.pool)) {
        throw new GateError(404, "model_not_found", "model not found", { param: "id" });
      }
      if (route.pool !== pool) return NextResponse.json(apiEntry(model, created));
      if (pool === "subscription") {
        return NextResponse.json(modelEntry(id, created, model.subscriptionPricing, model, "subscription"));
      }
      return NextResponse.json(modelEntry(id, created, model.pricing, model));
    } catch (err) {
      return gateResponse(err, req);
    }
  };
}
