import { SUBSCRIPTION_PREFIX } from "@/lib/gateway/api-paths";
import { isSignInKind } from "@/lib/gateway/upstreams/provider-kinds";
import { GateError } from "@/lib/gateway/errors";
import { ANTHROPIC_ROUTE_PREFIX, API_ROUTE_PREFIX, plainModel } from "@/lib/gateway/catalog/model-alias";
import type { PublicModel } from "@/types/models";
import type { PooledRoute, PublicPool, RoutePool } from "@/types/routing";

export function routePool(route: PooledRoute): RoutePool {
  if (isSignInKind(route.kind) || isSignInKind(route.provider?.kind ?? "")) return "subscription";
  return route.provider?.internal ? "internal" : "api";
}

export function routable(surface: RoutePool): (route: PooledRoute) => boolean {
  return (route) => {
    const pool = routePool(route);
    return pool === surface || (surface === "internal" && pool === "api");
  };
}

export function hiddenFrom(surface: RoutePool, routes: readonly PooledRoute[]): boolean {
  return surface !== "internal" && routes.length > 0 && routes.every((route) => routePool(route) === "internal");
}

export function listedIn(model: Pick<PublicModel, "pools">, pool: PublicPool): boolean {
  if (pool === "subscription") return model.pools.includes("subscription");
  return !model.pools.length || model.pools.includes("api");
}

export function routeOf(model: string, surface: RoutePool): { alias: string; pool: RoutePool } {
  let requested = model.trim();
  if (requested.toLowerCase().startsWith(ANTHROPIC_ROUTE_PREFIX)) {
    requested = requested.slice(ANTHROPIC_ROUTE_PREFIX.length).trim();
  }
  const lower = requested.toLowerCase();
  const usesApiPool =
    surface === "subscription" &&
    lower.startsWith(API_ROUTE_PREFIX) &&
    lower.length > API_ROUTE_PREFIX.length;
  if (!usesApiPool) return { alias: requested, pool: surface };
  return { alias: plainModel(requested.slice(API_ROUTE_PREFIX.length).trim()), pool: "api" };
}

export function outsidePool(pool: RoutePool, surface: RoutePool = pool): GateError {
  if (pool === "subscription") return new GateError(404, "model_not_found", "model has no subscription route", { param: "model" });
  if (pool === "internal") return new GateError(404, "model_not_found", "model is only served by subscriptions", { param: "model" });
  return new GateError(
    404,
    "model_not_found",
    surface === "subscription"
      ? "model has no API route"
      : `model is only served by subscriptions; call it through ${SUBSCRIPTION_PREFIX}/v1`,
    { param: "model" },
  );
}
