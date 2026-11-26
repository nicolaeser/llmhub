import "server-only";
import { allowModel, applyGuardrails, gateRequest, gateResponse, modelOf, readBody } from "@/lib/gateway/access/gate";
import { GateError } from "@/lib/gateway/errors";
import { variantBody } from "@/lib/gateway/catalog/model-variants";
import { canonicalBody } from "@/lib/gateway/routing/name-route";
import { variantRoute } from "@/lib/gateway/routing/variant-route";
import { parseRequest } from "@/lib/gateway/protocols/parse-request";
import { finishRequest, trackRequest } from "@/lib/gateway/request-logs/request-activity";
import { requestClient } from "@/lib/gateway/request-logs/request-session";
import { sessionHeaders, withDeploymentHeader } from "@/lib/gateway/routing/deployment-affinity";
import type { ZodType } from "zod";
import type { GatedRequest, RequestTrace, ScreenedRequest, ScreenOptions } from "@/types/gateway";

const requestTraces = new WeakMap<Request, RequestTrace>();

export function gatewayRoute(handle: (req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
  return async (req) => {
    try {
      const res = withDeploymentHeader(await handle(req), requestTraces.get(req));
      if (!isEventStream(res)) finishRequest(requestTraces.get(req));
      return res;
    } catch (err) {
      finishRequest(requestTraces.get(req));
      return gateResponse(err, req);
    }
  };
}

function isEventStream(res: Response): boolean {
  return res.headers.get("content-type")?.toLowerCase().includes("text/event-stream") ?? false;
}

export async function gateModelRequest(req: Request, options: ScreenOptions = {}): Promise<GatedRequest> {
  const gated = await gateRequest(options.auth ?? req, options.pool);
  const raw = await readBody(req);
  if (gated.trace) {
    gated.trace.sessionHeaders = sessionHeaders(req.headers);
    requestTraces.set(req, gated.trace);
  }
  const principal = { ...gated, client: requestClient(req.headers, raw) };
  trackRequest(principal, { model: modelOf(raw), stream: raw.stream === true });
  return { principal, raw };
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
