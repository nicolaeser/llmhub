import "server-only";
import { NextResponse } from "next/server";
import { gateRequest, gateResponse, modelPermitted } from "@/lib/gateway/access/gate";
import { GateError } from "@/lib/gateway/errors";
import { apiKeyRequest } from "@/lib/gateway/protocols/messages";
import { AUTO_MODEL, modelEntry } from "@/lib/gateway/core";
import { ANTHROPIC_ROUTE_PREFIX, API_ROUTE_PREFIX, modelAlias } from "@/lib/gateway/catalog/model-alias";
import { splitVariant, VARIANT_LABELS, variantAlias } from "@/lib/gateway/catalog/model-variants";
import { CODEX_VERSION_PARAM, codexCatalog } from "@/lib/gateway/catalog/codex-catalog";
import { catalogFacts } from "@/lib/gateway/catalog/model-context";
import { pricedModels } from "@/lib/gateway/catalog/model-pricing";
import { listedIn, routeOf } from "@/lib/gateway/routing/route-pool";
import type { JsonMap } from "@/types/gateway";
import type { PublicModel } from "@/types/models";
import type { PublicPool } from "@/types/routing";

function apiEntry(model: PublicModel, created: Date) {
  const label = `${model.displayName || model.alias} (API)`;
  return modelEntry(`${API_ROUTE_PREFIX}${model.alias}`, created, model.pricing, { ...model, displayName: label }, "api");
}

function variantEntries(model: PublicModel, pool: PublicPool, surface: PublicPool, created: Date, taken: ReadonlySet<string>) {
  const viaApi = pool !== surface;
  const name = model.displayName || model.alias;
  return model.variants
    .filter((route) => route.pools.includes(pool) && !taken.has(variantAlias(model.alias, route.variant)))
    .map(({ variant }) => {
      const label = viaApi ? `${name} (API, ${VARIANT_LABELS[variant]})` : `${name} (${VARIANT_LABELS[variant]})`;
      const id = `${viaApi ? API_ROUTE_PREFIX : ""}${variantAlias(model.alias, variant)}`;
      const route = viaApi ? "api" : surface === "subscription" ? "subscription" : undefined;
      return { ...modelEntry(id, created, null, { ...model, displayName: label }, route), variant };
    });
}

export function modelEntries(
  models: PublicModel[],
  pool: PublicPool,
  allowed: (alias: string) => boolean,
  created: Date,
): JsonMap[] {
  const taken = new Set(models.map((model) => model.alias));
  const permitted = models.filter((model) => allowed(model.alias));
  const listed = permitted.filter((model) => listedIn(model, pool));
  const own = listed.map((model) =>
    pool === "subscription"
      ? modelEntry(model.alias, created, model.subscriptionPricing, model, "subscription")
      : modelEntry(model.alias, created, model.pricing, model),
  );
  const ownVariants = listed.flatMap((model) => variantEntries(model, pool, pool, created, taken));
  const api = pool === "subscription" ? permitted.filter((model) => listedIn(model, "api")) : [];
  const viaApi = api.map((model) => apiEntry(model, created));
  const apiVariants = api.flatMap((model) => variantEntries(model, "api", pool, created, taken));
  return [...own, ...ownVariants, ...viaApi, ...apiVariants];
}

export function listModelsRoute(pool: PublicPool) {
  return async (req: Request): Promise<Response> => {
    try {
      const principal = await gateRequest(apiKeyRequest(req), pool);
      const created = new Date();
      const models = [...(await pricedModels(created)), AUTO_MODEL];
      const data = modelEntries(models, pool, (alias) => modelPermitted(principal, alias), created);
      if (new URL(req.url).searchParams.has(CODEX_VERSION_PARAM)) {
        return NextResponse.json(codexCatalog(data, pool, await catalogFacts()));
      }
      const gatewayDiscovery = pool === "subscription" && new URL(req.url).searchParams.get("limit") === "1000";
      const listed = gatewayDiscovery
        ? data.map((entry) => ({ ...entry, id: `${ANTHROPIC_ROUTE_PREFIX}${String(entry.id)}` }))
        : data;
      return NextResponse.json({
        object: "list",
        data: listed,
        has_more: false,
        first_id: listed[0]?.id ?? null,
        last_id: listed.at(-1)?.id ?? null,
      });
    } catch (err) {
      return gateResponse(err, req);
    }
  };
}

export function retrieveModelRoute(pool: PublicPool) {
  return async (req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> => {
    try {
      const principal = await gateRequest(apiKeyRequest(req), pool);
      const requested = modelAlias((await ctx.params).id);
      const { alias } = routeOf(requested, pool);
      const listId = requested.toLowerCase().startsWith(ANTHROPIC_ROUTE_PREFIX)
        ? requested.slice(ANTHROPIC_ROUTE_PREFIX.length)
        : requested;
      const created = new Date();
      const base = splitVariant(alias)?.alias;
      const models = alias === AUTO_MODEL.alias ? [AUTO_MODEL] : await pricedModels(created, base ? [alias, base] : [alias]);
      const entry = modelEntries(models, pool, (model) => modelPermitted(principal, model), created).find(
        (candidate) => candidate.id === listId,
      );
      if (!entry) throw new GateError(404, "model_not_found", "model not found", { param: "id" });
      return NextResponse.json({ ...entry, id: requested });
    } catch (err) {
      return gateResponse(err, req);
    }
  };
}
