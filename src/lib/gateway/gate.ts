import "server-only";
import { bearerToken, clientIp, readJSON } from "@/lib/http/api";
import { authenticateBearer } from "@/lib/gateway/principal";
import { defaultEntityIds, redactJSON } from "@/lib/gateway/pii";
import { alertUpstreamFailure } from "@/lib/gateway/alerts";
import { resolvePii } from "@/lib/gateway/settings";
import { assertBudget, assertRate, recordUsage } from "@/lib/gateway/billing";
import { asRecord, isRouterError, newRequestId } from "@/lib/gateway/core";
import { anthropicErrorBody, GateError, openAIErrorBody } from "@/lib/gateway/errors";
import { logger } from "@/lib/logging/logger";
import { aliasChain } from "@/lib/gateway/runtime";
import { NextResponse } from "next/server";
import type { JsonMap, Principal } from "@/types/gateway";

export function toGateError(err: unknown): GateError {
  if (err instanceof GateError) return err;
  if (isRouterError(err, "unknown_group")) {
    return new GateError(404, "model_not_found", "no deployment for model", { param: "model" });
  }
  if (isRouterError(err, "no_healthy")) {
    return new GateError(503, "no_healthy_deployment", "no healthy deployment for model");
  }
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError") {
    return new GateError(504, "upstream_timeout", "upstream request timed out");
  }
  if (err instanceof TypeError && err.message === "fetch failed") {
    return new GateError(502, "upstream_error", "upstream request failed");
  }
  if ((err as { status?: number }).status === 413) {
    return new GateError(413, "payload_too_large", "request body is too large");
  }
  return new GateError(500, "internal_error", "internal server error");
}

export function wantsAnthropicErrors(req: Request): boolean {
  return new URL(req.url).pathname.startsWith("/v1/messages") || req.headers.has("anthropic-version");
}

export function gateResponse(err: unknown, req: Request): NextResponse {
  void alertUpstreamFailure(err);
  const gate = toGateError(err);
  const requestId = newRequestId();
  if (gate.status >= 500) {
    logger.error("gateway.error", { requestId, code: gate.code, err: String(err) });
  }
  if (wantsAnthropicErrors(req)) {
    return NextResponse.json(anthropicErrorBody(gate.status, gate.message, requestId), {
      status: gate.status,
      headers: { "request-id": requestId, "x-request-id": requestId },
    });
  }
  return NextResponse.json(openAIErrorBody(gate), {
    status: gate.status,
    headers: { "x-request-id": requestId },
  });
}

export function requestPath(req: Request): string {
  return URL.canParse(req.url) ? new URL(req.url).pathname : "";
}

export function withTrace(principal: Principal, endpoint: string): Principal {
  return {
    ...principal,
    trace: { endpoint, piiMode: "", piiInput: new Set(), piiOutput: new Set() },
  };
}

export async function gateRequest(req: Request): Promise<Principal> {
  const token = bearerToken(req);
  const ip = clientIp(req.headers);
  const principal = withTrace(await authenticateBearer(token), requestPath(req));
  if (principal.key?.allowed_ips.length) {
    if (!ip || !principal.key.allowed_ips.includes(ip)) {
      throw new GateError(403, "ip_not_allowed", "ip not allowed for this key");
    }
  }
  await admit(principal);
  return principal;
}

export async function admit(principal: Principal): Promise<void> {
  await assertBudget(principal);
  await assertRate(principal);
}

export function modelPermitted(principal: Principal, model: string): boolean {
  const allowed = principal.models;
  if (!allowed.length && !principal.key?.templates.length) return true;
  return allowed.includes("*") || allowed.includes(model);
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

export async function applyPii(
  body: JsonMap,
  principal: Principal,
): Promise<{ body: JsonMap; output: string[] | null }> {
  const trace = principal.trace;
  if (trace) trace.request = body;
  const pii = await resolvePii(principal);
  if (!pii.enabled) return { body, output: null };
  const entities = pii.entities.length ? pii.entities : defaultEntityIds();
  const found = new Set<string>();
  const redacted = redactJSON(body, entities, "", found) as JsonMap;
  if (trace) {
    trace.request = redacted;
    trace.piiMode = pii.mode;
    for (const id of found) trace.piiInput.add(id);
  }
  if (pii.mode === "block" && found.size) {
    const blocked = new GateError(400, "pii_blocked", "request blocked by PII policy");
    await recordUsage({
      principal,
      model: modelOf(body),
      status: blocked.status,
      outcome: "pii_blocked",
      latencyMs: 0,
      tag: spendTag(body),
      error: blocked,
    }).catch(() => undefined);
    throw blocked;
  }
  return { body: redacted, output: pii.output ? entities : null };
}

export async function readBody(req: Request): Promise<JsonMap> {
  try {
    const json = await readJSON<unknown>(req);
    if (!json || typeof json !== "object" || Array.isArray(json)) return {};
    return json as JsonMap;
  } catch (err) {
    if ((err as { status?: number }).status === 413) {
      throw new GateError(413, "payload_too_large", "request body is too large");
    }
    throw new GateError(400, "invalid_json", "request body must be JSON");
  }
}

export function modelOf(body: JsonMap, fallback = ""): string {
  return typeof body.model === "string" ? body.model : fallback;
}

export function spendTag(body: JsonMap): string {
  if (Array.isArray(body.tags) && typeof body.tags[0] === "string") return body.tags[0];
  const meta = asRecord(body.metadata);
  if (typeof meta?.tag === "string") return meta.tag;
  if (typeof body.tag === "string") return body.tag;
  if (typeof body.user === "string") return body.user;
  return "";
}
