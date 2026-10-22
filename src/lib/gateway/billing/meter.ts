import "server-only";
import { recordUsage, recordUsageOrLog } from "@/lib/gateway/billing/billing";
import { spendTag } from "@/lib/gateway/access/gate";
import { GateError } from "@/lib/gateway/errors";
import type { JsonMap, Principal, ProxyFirstResult } from "@/types/gateway";
import type { TokenUsage } from "@/types/billing";

type MeteredHit = Pick<ProxyFirstResult, "dep" | "group"> & Partial<Pick<ProxyFirstResult, "status" | "json">>;

export function meter(principal: Principal, model: string, body: JsonMap = {}) {
  const started = Date.now();
  const base = { principal, model, tag: spendTag(body), request: body };
  return {
    ok: (hit: MeteredHit, usage: Partial<TokenUsage> = {}, response: unknown = hit.json) =>
      recordUsage({
        ...base,
        deployment: hit.dep,
        group: hit.group,
        usage,
        status: hit.status ?? 200,
        outcome: "ok",
        latencyMs: Date.now() - started,
        response,
      }),
    fail: (err: unknown) =>
      recordUsageOrLog({
        ...base,
        status: err instanceof GateError ? err.status : 502,
        outcome: "error",
        latencyMs: Date.now() - started,
        error: err,
      }),
  };
}
