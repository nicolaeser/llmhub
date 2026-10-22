import "server-only";
import { recordUsage, recordUsageOrLog } from "@/lib/gateway/billing/billing";
import { spendTag } from "@/lib/gateway/access/gate";
import { CLIENT_CLOSED_STATUS, GateError, isClientClosed } from "@/lib/gateway/errors";
import type { JsonMap, Principal, ProxyFirstResult } from "@/types/gateway";
import type { TokenUsage } from "@/types/billing";

type MeteredHit = Pick<ProxyFirstResult, "dep" | "group"> & Partial<Pick<ProxyFirstResult, "status" | "json">>;

export function meter(principal: Principal, model: string, body: JsonMap = {}) {
  const started = Date.now();
  const base = { principal, model, tag: spendTag(body), request: body };
  const book = (hit: MeteredHit, usage: Partial<TokenUsage>, response: unknown, status: number, outcome: "ok" | "cancelled") =>
    recordUsage({
      ...base,
      deployment: hit.dep,
      group: hit.group,
      usage,
      status,
      outcome,
      latencyMs: Date.now() - started,
      response,
    });
  return {
    ok: (hit: MeteredHit, usage: Partial<TokenUsage> = {}, response: unknown = hit.json) =>
      book(hit, usage, response, hit.status ?? 200, "ok"),
    cancelled: (hit: MeteredHit, usage: Partial<TokenUsage> = {}, response: unknown = hit.json) =>
      book(hit, usage, response, CLIENT_CLOSED_STATUS, "cancelled"),
    fail: (err: unknown) =>
      recordUsageOrLog({
        ...base,
        status: err instanceof GateError ? err.status : 502,
        outcome: isClientClosed(err) ? "cancelled" : "error",
        latencyMs: Date.now() - started,
        error: err,
      }),
  };
}
