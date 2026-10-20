import packageJson from "../../../package.json";
import { GateError } from "@/lib/gateway/errors";
import { PROVIDER_CATALOG } from "@/lib/gateway/upstreams/provider-kinds";
import type { JsonMap, Principal } from "@/types/gateway";
import type { ModelPricing, PublicModel } from "@/types/models";
import type { RoutePool, RouterWait } from "@/types/routing";

export class RouterError extends Error {
  constructor(
    message: string,
    readonly code: "unknown_group" | "no_healthy" | "all_paused" | "not_assigned" | "unknown_strategy",
    readonly wait: RouterWait | null = null,
  ) {
    super(message);
    this.name = "RouterError";
  }
}

export const ERR_UNKNOWN_GROUP = new RouterError(
  "router: unknown model group",
  "unknown_group",
);
export const ERR_NO_HEALTHY = new RouterError(
  "router: no healthy deployment",
  "no_healthy",
);
export const ERR_ALL_PAUSED = new RouterError(
  "router: every deployment is paused",
  "all_paused",
);
export const ERR_NOT_ASSIGNED = new RouterError(
  "router: no subscription account is assigned to this caller",
  "not_assigned",
);

export function waitingError(wait: RouterWait): RouterError {
  return new RouterError(
    wait.limited ? "router: every deployment is rate limited" : "router: every deployment is cooling down",
    "no_healthy",
    wait,
  );
}

export function isRouterError(err: unknown, code?: RouterError["code"]): err is RouterError {
  return err instanceof RouterError && (code ? err.code === code : true);
}

export function isUnavailableError(err: unknown): err is RouterError {
  return isRouterError(err, "no_healthy") || isRouterError(err, "all_paused");
}

export function routerGateError(err: unknown): GateError | null {
  if (isRouterError(err, "unknown_group")) {
    return new GateError(404, "model_not_found", "no deployment for model", { param: "model" });
  }
  if (isRouterError(err, "not_assigned")) {
    return new GateError(403, "account_not_assigned", "no subscription account is assigned to this key");
  }
  if (isUnavailableError(err)) {
    const wait = err.wait;
    if (wait?.limited) {
      return new GateError(429, "rate_limit_exceeded", limitMessage(wait), { retryAt: wait.retryAt });
    }
    return new GateError(503, "no_healthy_deployment", "no healthy deployment for model", {
      retryAt: wait?.retryAt ?? null,
    });
  }
  return null;
}

function kindName(kind: string): string {
  return PROVIDER_CATALOG.find((spec) => spec.kind === kind)?.name ?? kind;
}

export function waitText(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours}h ${rest}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

export function limitMessage(wait: RouterWait, now = Date.now()): string {
  const subject = wait.kinds.length
    ? `all ${wait.kinds.map(kindName).join(" and ")} accounts have reached their usage limit`
    : "all deployments for this model are rate limited";
  const when = new Date(wait.retryAt).toISOString();
  return `${subject}; the next one is available again at ${when} (in ${waitText(wait.retryAt - now)})`;
}

export function ownerId(pr: Principal | null | undefined): string {
  if (!pr) return "";
  if (pr.key?.token_id) return pr.key.token_id;
  if (pr.userId) return pr.userId;
  return pr.actor;
}

export function asRecord(v: unknown): JsonMap | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as JsonMap)
    : null;
}

export function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function asNumber(v: unknown, fallback = 0): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export function asBool(v: unknown, fallback = false): boolean {
  if (typeof v === "boolean") return v;
  return fallback;
}

export function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

export function asNumberArray(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "number" ? x : Number(x)))
    .filter((n) => Number.isFinite(n) && n > 0);
}

export function asStringMap(v: unknown): Record<string, string> {
  const rec = asRecord(v);
  if (!rec) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(rec)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

export function stringifyContent(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    let out = "";
    for (const x of v) {
      const rec = asRecord(x);
      if (rec && typeof rec.text === "string") out += rec.text;
      else if (typeof x === "string") out += x;
    }
    return out;
  }
  if (v == null) return "";
  return String(v);
}

export function newId(bytes = 12): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function newRequestId(): string {
  return `req_${newId(12)}`;
}

export function modelEntry(
  id: string,
  created: Date,
  pricing?: ModelPricing | null,
  origin?: Pick<PublicModel, "vendor" | "displayName" | "tags">,
  route?: RoutePool,
): JsonMap {
  return {
    id,
    object: "model",
    created: Math.floor(created.getTime() / 1000),
    owned_by: origin?.vendor || "llm-hub",
    type: "model",
    display_name: origin?.displayName || id,
    created_at: created.toISOString(),
    ...(origin?.tags.length ? { tags: origin.tags } : {}),
    ...(pricing ? { pricing } : {}),
    ...(route ? { route } : {}),
  };
}

export const AUTO_MODEL: PublicModel = {
  alias: "auto",
  vendor: "",
  displayName: "",
  tags: [],
  pricing: null,
  pools: ["api", "subscription"],
  variants: [],
};

export const VERSION = packageJson.version;

export const KNOWN_STRATEGIES = new Set([
  "least_inflight",
  "weighted_random",
  "cost_lowest",
  "priority",
  "fast",
  "round_robin",
  "quota_balanced",
  "quota_expiring",
  "smart",
]);

export const KNOWN_KINDS = new Set(PROVIDER_CATALOG.map((spec) => spec.kind));


export const BILLING_MODES = ["routed", "average", "custom"] as const;

export const KNOWN_BILLING_MODES = new Set<string>(BILLING_MODES);
