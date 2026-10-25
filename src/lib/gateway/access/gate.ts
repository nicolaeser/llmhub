import "server-only";
import { bearerToken, isPayloadTooLarge, readJSON } from "@/lib/http/api";
import { clientIp, ipAllowed } from "@/lib/http/client-ip";
import { authenticateBearer } from "@/lib/gateway/access/principal";
import { defaultEntityIds } from "@/lib/gateway/safety/pii";
import { redactWithPolicy } from "@/lib/gateway/safety/pii-detector";
import { bindPiiVault, PiiVault } from "@/lib/gateway/safety/pii-vault";
import { outputGuard, screenRequest } from "@/lib/gateway/safety/guardrails";
import { alertPiiBlocked, alertUpstreamFailure } from "@/lib/alerts/notify";
import { resolvePolicies } from "@/lib/settings/enterprise";
import { assertBudget, assertRate, recordUsageOrLog } from "@/lib/gateway/billing/billing";
import { capRequestCost, maxCostHeader } from "@/lib/gateway/billing/cost-cap";
import { asRecord, newRequestId, routerGateError } from "@/lib/gateway/core";
import {
  anthropicErrorBody,
  CLIENT_RETRY_MAX_SECONDS,
  GateError,
  openAIErrorBody,
  usageLimitReset,
} from "@/lib/gateway/errors";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { modelAlias } from "@/lib/gateway/catalog/model-alias";
import { aliasChain, servedOnlyInternally } from "@/lib/gateway/routing/runtime";
import { accessOpen, endpointAllowed } from "@/lib/gateway/access/key-restrictions";
import { gatewayPath } from "@/lib/gateway/api-paths";
import { routeOf } from "@/lib/gateway/routing/route-pool";
import { NextResponse } from "next/server";
import type { JsonMap, Principal } from "@/types/gateway";
import type { PublicPool } from "@/types/routing";
import type { OutputGuard } from "@/types/guardrails";

export function toGateError(err: unknown): GateError {
  if (err instanceof GateError) return err;
  const routed = routerGateError(err);
  if (routed) return routed;
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError") {
    return new GateError(504, "upstream_timeout", "upstream request timed out");
  }
  if (err instanceof TypeError && err.message === "fetch failed") {
    return new GateError(502, "upstream_error", "upstream request failed");
  }
  if (isPayloadTooLarge(err)) {
    return new GateError(413, "payload_too_large", "request body is too large");
  }
  return new GateError(500, "internal_error", "internal server error");
}

export function wantsAnthropicErrors(req: Request): boolean {
  return gatewayPath(new URL(req.url).pathname).startsWith("/v1/messages") || req.headers.has("anthropic-version");
}

export function retryHeaders(gate: GateError, now = Date.now()): Record<string, string> {
  if (gate.requestScoped) return { "x-should-retry": "false" };
  if (gate.retryAt === null || (gate.status !== 429 && gate.status < 500)) return {};
  const seconds = Math.max(1, Math.ceil((gate.retryAt - now) / 1000));
  return {
    "retry-after": String(seconds),
    "x-should-retry": seconds > CLIENT_RETRY_MAX_SECONDS ? "false" : "true",
  };
}

export function usageLimitHeaders(gate: GateError, anthropic: boolean, now = Date.now()): Record<string, string> {
  const resetsAt = usageLimitReset(gate, now);
  if (resetsAt === null) return {};
  if (anthropic) {
    return {
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-reset": String(resetsAt),
      "anthropic-ratelimit-unified-overage-disabled-reason": "unknown",
    };
  }
  return { "x-codex-primary-used-percent": "100", "x-codex-primary-reset-at": String(resetsAt) };
}

export function gateResponse(err: unknown, req: Request): NextResponse {
  void alertUpstreamFailure(err);
  const gate = toGateError(err);
  const requestId = newRequestId();
  if (gate.status >= 500) {
    logger.error("gateway.error", { requestId, code: gate.code, ...errorFields(err) });
  }
  const now = Date.now();
  const retry = retryHeaders(gate, now);
  if (wantsAnthropicErrors(req)) {
    return NextResponse.json(anthropicErrorBody(gate.status, gate.message, requestId), {
      status: gate.status,
      headers: { "request-id": requestId, "x-request-id": requestId, ...retry, ...usageLimitHeaders(gate, true, now) },
    });
  }
  return NextResponse.json(openAIErrorBody(gate, now), {
    status: gate.status,
    headers: { "x-request-id": requestId, ...retry, ...usageLimitHeaders(gate, false, now) },
  });
}

export function requestPath(req: Request): string {
  return URL.canParse(req.url) ? new URL(req.url).pathname : "";
}

export function withTrace(principal: Principal, endpoint: string): Principal {
  return {
    ...principal,
    trace: {
      endpoint,
      piiMode: "",
      piiInput: new Set(),
      piiOutput: new Set(),
      guardInput: new Set(),
      guardOutput: new Set(),
      guardBlocked: false,
    },
  };
}

export async function gateRequest(req: Request, pool: PublicPool = "api"): Promise<Principal> {
  const token = bearerToken(req);
  const path = requestPath(req);
  const principal = { ...withTrace(await authenticateBearer(token), path), pool };
  if (principal.key?.allowed_ips.length && !ipAllowed(principal.key.allowed_ips, clientIp(req.headers))) {
    throw new GateError(403, "ip_not_allowed", "ip not allowed for this key");
  }
  allowEndpoint(principal, gatewayPath(path));
  allowAccessTime(principal, new Date());
  await admit(principal, maxCostHeader(req.headers));
  return principal;
}

export function allowEndpoint(principal: Principal, path: string, param?: string): void {
  if (principal.key && !endpointAllowed(principal.key.allowed_endpoints, path)) {
    throw new GateError(403, "endpoint_not_allowed", "endpoint not allowed for this key", { param });
  }
}

export function allowAccessTime(principal: Principal, at: Date): void {
  const key = principal.key;
  if (key && !accessOpen(key.access_windows, key.access_time_zone, at)) {
    throw new GateError(403, "outside_access_window", "this key is outside its allowed time windows");
  }
}

export async function admit(principal: Principal, maxCost: number | null = null): Promise<void> {
  const budget = await assertBudget(principal);
  await assertRate(principal);
  capRequestCost(principal, budget, maxCost);
}

export function modelPermitted(principal: Principal, model: string): boolean {
  const allowed = principal.models;
  if (!allowed.length && !principal.key?.templates.length) return true;
  return allowed.includes("*") || allowed.includes(modelAlias(routeOf(model, principal.pool ?? "api").alias));
}

export async function featureModelPermitted(principal: Principal, model: string): Promise<boolean> {
  if (modelPermitted(principal, model)) return true;
  return !principal.dataRules && (await servedOnlyInternally(model));
}

export function allowModel(principal: Principal, model: string): void {
  if (!model) {
    throw new GateError(400, "missing_required_parameter", "model is required", { param: "model" });
  }
  if (!modelPermitted(principal, model)) {
    throw new GateError(403, "model_access_denied", "model not allowed for this key", { param: "model" });
  }
}

export function modelChain(principal: Principal, model: string, body: JsonMap): string[] {
  const aliases = aliasChain(model, body);
  for (const alias of aliases) {
    if (!modelPermitted(principal, alias)) {
      throw new GateError(403, "model_access_denied", `fallback model ${alias} not allowed for this key`, {
        param: "model",
      });
    }
  }
  return aliases;
}

async function rejectRequest(principal: Principal, body: JsonMap, error: GateError, outcome: string): Promise<never> {
  await recordUsageOrLog({
    principal,
    model: modelOf(body),
    status: error.status,
    outcome,
    latencyMs: 0,
    tag: spendTag(body),
    error,
  });
  throw error;
}

export async function applyGuardrails(
  body: JsonMap,
  principal: Principal,
): Promise<{ body: JsonMap; output: OutputGuard | null }> {
  const trace = principal.trace;
  if (trace) trace.request = body;
  const { pii, guardrails } = await resolvePolicies(principal);
  const screened = screenRequest(body, guardrails, trace?.guardInput ?? new Set());
  if (trace) trace.request = screened.body;
  if (screened.blocked) {
    if (trace) trace.guardBlocked = true;
    await rejectRequest(
      principal,
      body,
      new GateError(400, "guardrail_blocked", "request blocked by guardrail policy"),
      "guardrail_blocked",
    );
  }
  if (!pii.enabled) return { body: screened.body, output: outputGuard(guardrails, null) };
  const entities = pii.entities.length ? pii.entities : defaultEntityIds();
  const found = new Set<string>();
  const vault = pii.mode === "restore" ? new PiiVault() : null;
  let redacted: JsonMap;
  try {
    redacted = (await redactWithPolicy(screened.body, pii, found, vault)) as JsonMap;
  } catch (err) {
    if (!(err instanceof GateError)) throw err;
    return rejectRequest(principal, body, err, "pii_blocked");
  }
  if (trace) {
    trace.request = redacted;
    trace.piiMode = pii.mode;
    if (vault) bindPiiVault(trace, vault);
    for (const id of found) trace.piiInput.add(id);
  }
  if (pii.mode === "block" && found.size) {
    void alertPiiBlocked(principal, found);
    await rejectRequest(
      principal,
      body,
      new GateError(400, "pii_blocked", "request blocked by PII policy"),
      "pii_blocked",
    );
  }
  return { body: redacted, output: outputGuard(guardrails, pii.output ? entities : null) };
}

export async function readBody(req: Request): Promise<JsonMap> {
  try {
    const json = await readJSON<unknown>(req);
    if (!json || typeof json !== "object" || Array.isArray(json)) return {};
    return json as JsonMap;
  } catch (err) {
    if (isPayloadTooLarge(err)) {
      throw new GateError(413, "payload_too_large", "request body is too large");
    }
    throw new GateError(400, "invalid_json", "request body must be JSON");
  }
}

export function modelOf(body: JsonMap, fallback = ""): string {
  return typeof body.model === "string" ? modelAlias(body.model) : fallback;
}

export function spendTag(body: JsonMap): string {
  if (Array.isArray(body.tags) && typeof body.tags[0] === "string") return body.tags[0];
  const meta = asRecord(body.metadata);
  if (typeof meta?.tag === "string") return meta.tag;
  if (typeof body.tag === "string") return body.tag;
  if (typeof body.user === "string") return body.user;
  return "";
}
