import "server-only";
import { allowModel, applyGuardrails, gateRequest, gateResponse, modelOf, readBody } from "@/lib/gateway/access/gate";
import { GateError } from "@/lib/gateway/errors";
import { parseRequest } from "@/lib/gateway/protocols/parse-request";
import type { ZodType } from "zod";
import type { ScreenedRequest, ScreenOptions } from "@/types/gateway";

export function gatewayRoute(handle: (req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
  return async (req) => {
    try {
      return await handle(req);
    } catch (err) {
      return gateResponse(err, req);
    }
  };
}

export async function screenModelRequest(req: Request, options: ScreenOptions = {}): Promise<ScreenedRequest> {
  const principal = await gateRequest(options.auth ?? req, options.pool);
  const body = await readBody(req);
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
