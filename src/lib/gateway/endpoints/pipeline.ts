import "server-only";
import { allowModel, applyGuardrails, gateRequest, gateResponse, modelOf, readBody } from "@/lib/gateway/access/gate";
import { GateError } from "@/lib/gateway/errors";
import { variantBody } from "@/lib/gateway/catalog/model-variants";
import { canonicalBody } from "@/lib/gateway/routing/name-route";
import { variantRoute } from "@/lib/gateway/routing/variant-route";
import { parseRequest } from "@/lib/gateway/protocols/parse-request";
import { requestClient } from "@/lib/gateway/request-logs/request-session";
import { sessionHeaders, withDeploymentHeader } from "@/lib/gateway/routing/deployment-affinity";
import type { ZodType } from "zod";
import type { GatedRequest, RequestTrace, ScreenedRequest, ScreenOptions } from "@/types/gateway";

const requestTraces = new WeakMap<Request, RequestTrace>();

export function gatewayRoute(handle: (req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
  return async (req) => {
    try {
      return withDeploymentHeader(await handle(req), requestTraces.get(req));
    } catch (err) {
      return gateResponse(err, req);
    }
  };
}

export async function gateModelRequest(req: Request, options: ScreenOptions = {}): Promise<GatedRequest> {
  const gated = await gateRequest(options.auth ?? req, options.pool);
  const raw = await readBody(req);
  if (gated.trace) {
    gated.trace.sessionHeaders = sessionHeaders(req.headers);
    requestTraces.set(req, gated.trace);
  }
  return { principal: { ...gated, client: requestClient(req.headers, raw) }, raw };
}

export async function screenModelRequest(req: Request, options: ScreenOptions = {}): Promise<ScreenedRequest> {
  return screenGatedRequest(await gateModelRequest(req, options));
}

export async function screenGatedRequest({ principal, raw }: GatedRequest): Promise<ScreenedRequest> {
  const named = await canonicalBody(raw);
  const variant = await variantRoute(modelOf(named), principal.pool ?? "api");
  const body = variant ? variantBody(named, variant.model, variant.variant) : named;
  const model = modelOf(body);
  allowModel(principal, model);
  const { body: clean, output } = await applyGuardrails(body, principal);
  return { principal, model, body, clean, output };
}

export function validRequest<T>(schema: ZodType<T>, body: unknown, invalidStatus = 400): T {
  const parsed = parseRequest(schema, body);
  if (!parsed.ok) throw new GateError(invalidStatus, "invalid_request", parsed.message, { param: parsed.param });
  return parsed.data;
}
