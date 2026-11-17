import "server-only";
import { NextResponse } from "next/server";
import { gateRequest, gateResponse, modelPermitted } from "@/lib/gateway/access/gate";
import { GateError } from "@/lib/gateway/errors";
import { apiKeyRequest } from "@/lib/gateway/protocols/messages";
import { AUTO_MODEL, modelEntry } from "@/lib/gateway/core";
import { anthropicPublicIds } from "@/lib/gateway/catalog/anthropic-native";
import { ANTHROPIC_ROUTE_PREFIX, API_ROUTE_PREFIX, modelAlias } from "@/lib/gateway/catalog/model-alias";
import { nameIndex } from "@/lib/gateway/catalog/model-names";
import { splitVariant, VARIANT_LABELS, variantAlias } from "@/lib/gateway/catalog/model-variants";
import { CODEX_VERSION_PARAM, codexCatalog } from "@/lib/gateway/catalog/codex-catalog";
import { catalogFacts } from "@/lib/gateway/catalog/model-context";
import { pricedModels } from "@/lib/gateway/catalog/model-pricing";
import { canonicalModel, modelResolver } from "@/lib/gateway/routing/name-route";
import { listedIn, routeOf } from "@/lib/gateway/routing/route-pool";
import { modelRole } from "@/lib/models/model-role";
import type { JsonMap } from "@/types/gateway";
import type { PublicModel } from "@/types/models";
import type { PublicPool } from "@/types/routing";

const GATEWAY_DISCOVERY_LIMIT = "1000";

const CLAUDE_SHAPED = /claude|anthropic/i;

function routedId(id: string, pool: PublicPool, surface: PublicPool): string {
  return pool === surface ? id : `${API_ROUTE_PREFIX}${id}`;
}

function routedEntry(model: PublicModel, id: string, pool: PublicPool, surface: PublicPool, created: Date): JsonMap {
  if (pool !== surface) {
    const label = `${model.displayName || id} (API)`;
    return modelEntry(routedId(id, pool, surface), created, model.pricing, { ...model, displayName: label }, "api");
  }
  return surface === "subscription"
    ? modelEntry(id, created, model.subscriptionPricing, model, "subscription")
    : modelEntry(id, created, model.pricing, model);
}

function variantEntries(model: PublicModel, pool: PublicPool, surface: PublicPool, created: Date, taken: ReadonlySet<string>) {
  const viaApi = pool !== surface;
  const name = model.displayName || model.alias;
  return model.variants
    .filter((route) => route.pools.includes(pool) && !taken.has(variantAlias(model.alias, route.variant)))
    .map(({ variant }) => {
      const label = viaApi ? `${name} (API, ${VARIANT_LABELS[variant]})` : `${name} (${VARIANT_LABELS[variant]})`;
      const id = routedId(variantAlias(model.alias, variant), pool, surface);
      const route = viaApi ? "api" : surface === "subscription" ? "subscription" : undefined;
      return { ...modelEntry(id, created, null, { ...model, displayName: label }, route), variant };
    });
}

function routePools(surface: PublicPool): PublicPool[] {
  return surface === "subscription" ? ["subscription", "api"] : ["api"];
}

export function modelEntries(models: PublicModel[], surface: PublicPool, allowed: (alias: string) => boolean, created: Date): JsonMap[] {
  const taken = new Set(models.map((model) => model.alias));
  const permitted = models.filter((model) => allowed(model.alias));
  return routePools(surface).flatMap((pool) =>
    permitted
      .filter((model) => listedIn(model, pool))
      .flatMap((model) => [
        routedEntry(model, model.alias, pool, surface, created),
        ...variantEntries(model, pool, surface, created, taken),
      ]),
  );
}

export function extraNameEntries(models: PublicModel[], surface: PublicPool, allowed: (alias: string) => boolean, created: Date): JsonMap[] {
  const owners = nameIndex(models, new Set(models.map((model) => model.alias)));
  const permitted = models.filter((model) => allowed(model.alias));
  return routePools(surface).flatMap((pool) =>
    permitted
      .filter((model) => listedIn(model, pool))
      .flatMap((model) =>
        model.extraNames
          .filter((name) => owners.get(name) === model.alias)
          .map((name) => routedEntry(model, name, pool, surface, created)),
      ),
  );
}

function nativeAliasEntries(
  models: PublicModel[],
  surface: PublicPool,
  allowed: (alias: string) => boolean,
  created: Date,
  resolve: (model: string) => string,
): JsonMap[] {
  return models
    .filter((model) => allowed(model.alias) && listedIn(model, surface))
    .flatMap((model) =>
      anthropicPublicIds(model.alias)
        .filter((id) => resolve(id) === model.alias)
        .map((id) => routedEntry(model, id, surface, surface, created)),
    );
}

export function gatewayDiscoveryEntries(entries: JsonMap[]): JsonMap[] {
  return entries
    .filter((entry) => modelRole([String(entry.id), String(entry.display_name ?? "")]) === "chat")
    .filter((entry) => !(entry.variant === "fast" || entry.variant === "ultrafast") || !CLAUDE_SHAPED.test(String(entry.id)))
    .map((entry) => {
      const id = String(entry.id);
      return CLAUDE_SHAPED.test(id) ? entry : { ...entry, id: `${ANTHROPIC_ROUTE_PREFIX}${id}` };
    });
}

function listResponse(data: JsonMap[]): Response {
  return NextResponse.json({
    object: "list",
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data.at(-1)?.id ?? null,
  });
}

export function listModelsRoute(pool: PublicPool) {
  return async (req: Request): Promise<Response> => {
    try {
      const principal = await gateRequest(apiKeyRequest(req), pool);
      const created = new Date();
      const models = [...(await pricedModels(created)), AUTO_MODEL];
      const allowed = (alias: string) => modelPermitted(principal, alias);
      const listed = modelEntries(models, pool, allowed, created);
      const query = new URL(req.url).searchParams;
      if (query.has(CODEX_VERSION_PARAM)) {
        const named = extraNameEntries(models, pool, allowed, created);
        return NextResponse.json(codexCatalog(listed, pool, await catalogFacts(), named));
      }
      const gatewayDiscovery = pool === "subscription" && query.get("limit") === GATEWAY_DISCOVERY_LIMIT;
      if (!gatewayDiscovery) return listResponse(listed);
      const native = nativeAliasEntries(models, pool, allowed, created, await modelResolver());
      return listResponse(gatewayDiscoveryEntries([...listed, ...native]));
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
      const resolved = await canonicalModel(alias);
      const named = resolved === alias ? undefined : resolved;
      const lookup = [alias, base, named].filter((name): name is string => Boolean(name));
      const models = alias === AUTO_MODEL.alias ? [AUTO_MODEL] : await pricedModels(created, lookup);
      const allowed = (model: string) => modelPermitted(principal, model);
      const entries = [...modelEntries(models, pool, allowed, created), ...extraNameEntries(models, pool, allowed, created)];
      const ownerId = named && listId.endsWith(alias) ? `${listId.slice(0, listId.length - alias.length)}${named}` : named;
      const entry =
        entries.find((candidate) => candidate.id === listId) ??
        (ownerId ? entries.find((candidate) => candidate.id === ownerId) : undefined);
      if (!entry) throw new GateError(404, "model_not_found", "model not found", { param: "id" });
      return NextResponse.json({ ...entry, id: requested });
    } catch (err) {
      return gateResponse(err, req);
    }
  };
}
