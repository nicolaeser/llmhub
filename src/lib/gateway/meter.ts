import "server-only";
import { recordUsage } from "@/lib/gateway/billing";
import { spendTag } from "@/lib/gateway/gate";
import { GateError } from "@/lib/gateway/errors";
import type { JsonMap, Principal, ProxyFirstResult, Usage } from "@/types/gateway";

export function meter(principal: Principal, model: string, body: JsonMap = {}) {
  const started = Date.now();
  const base = { principal, model, tag: spendTag(body), request: body };
  return {
    ok: (hit: ProxyFirstResult, usage: Partial<Usage> = {}, response: unknown = hit.json) =>
      recordUsage({
        ...base,
        deployment: hit.dep,
        group: hit.group,
        usage,
        status: hit.status,
        outcome: "ok",
        latencyMs: Date.now() - started,
        response,
      }),
    fail: (err: unknown) =>
      recordUsage({
        ...base,
        status: err instanceof GateError ? err.status : 502,
        outcome: "error",
        latencyMs: Date.now() - started,
        error: err,
      }).catch(() => undefined),
  };
}
