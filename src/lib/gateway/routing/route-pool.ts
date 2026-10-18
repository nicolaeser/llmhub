import { SUBSCRIPTION_PREFIX } from "@/lib/gateway/api-paths";
import { isSignInKind } from "@/lib/gateway/upstreams/provider-kinds";
import { GateError } from "@/lib/gateway/errors";
import { ANTHROPIC_ROUTE_PREFIX, API_ROUTE_PREFIX, plainModel } from "@/lib/gateway/catalog/model-alias";
import type { PublicModel } from "@/types/models";
import type { RoutePool } from "@/types/routing";

type PooledRoute = { kind: string; provider?: { kind: string } | null };

export function routePool(route: PooledRoute): RoutePool {
  return isSignInKind(route.kind) || isSignInKind(route.provider?.kind ?? "") ? "subscription" : "api";
}

export function inPool(pool: RoutePool): (route: PooledRoute) => boolean {
  return (route) => routePool(route) === pool;
}

export function listedIn(model: Pick<PublicModel, "pools">, pool: RoutePool): boolean {
  if (pool === "subscription") return model.pools.includes("subscription");
  return !model.pools.length || model.pools.includes("api");
}

export function routeOf(model: string, surface: RoutePool): { alias: string; pool: RoutePool } {
  let requested = model.trim();
  if (requested.toLowerCase().startsWith(ANTHROPIC_ROUTE_PREFIX)) {
    requested = requested.slice(ANTHROPIC_ROUTE_PREFIX.length).trim();
  }
  const alias = plainModel(requested);
  const usesApiPool = requested.toLowerCase().startsWith(API_ROUTE_PREFIX);
  return surface === "subscription" && usesApiPool
    ? { alias, pool: "api" }
    : { alias: usesApiPool ? alias : requested, pool: surface };
}

export function outsidePool(pool: RoutePool, surface: RoutePool = pool): GateError {
  if (pool === "subscription") return new GateError(404, "model_not_found", "model has no subscription route", { param: "model" });
  return new GateError(
    404,
    "model_not_found",
    surface === "subscription"
      ? "model has no API route"
      : `model is only served by subscriptions; call it through ${SUBSCRIPTION_PREFIX}/v1`,
    { param: "model" },
  );
}
