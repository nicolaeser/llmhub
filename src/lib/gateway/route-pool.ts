import { isSignInKind } from "@/lib/gateway/catalog";
import { GateError } from "@/lib/gateway/errors";
import type { PublicModel, RoutePool } from "@/types/gateway";

type PooledRoute = { kind: string; provider?: { kind: string } | null };

export const SUBSCRIPTION_PREFIX = "/subscription";

export function gatewayPath(pathname: string): string {
  return pathname.startsWith(`${SUBSCRIPTION_PREFIX}/`) ? pathname.slice(SUBSCRIPTION_PREFIX.length) : pathname;
}

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

export function outsidePool(pool: RoutePool): GateError {
  return new GateError(
    404,
    "model_not_found",
    pool === "subscription"
      ? "model has no subscription route"
      : `model is only served by subscriptions; call it through ${SUBSCRIPTION_PREFIX}/v1`,
    { param: "model" },
  );
}
