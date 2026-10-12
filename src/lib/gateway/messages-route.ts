import "server-only";
import { NextResponse } from "next/server";
import {
  allowModel,
  applyGuardrails,
  gateRequest,
  gateResponse,
  modelOf,
  readBody,
  modelChain,
} from "@/lib/gateway/gate";
import { GateError } from "@/lib/gateway/errors";
import { anthropicPassthroughHeaders, apiKeyRequest } from "@/lib/gateway/messages";
import { dispatchMessages, streamMessages } from "@/lib/gateway/messages-dispatch";
import { parseRequest } from "@/lib/gateway/responses";
import { messagesRequestSchema } from "@/schemas/anthropic";
import type { RoutePool } from "@/types/gateway";

export function messagesRoute(pool: RoutePool) {
  return async (req: Request): Promise<Response> => {
    try {
      const principal = await gateRequest(apiKeyRequest(req), pool);
      const body = await readBody(req);
      const model = modelOf(body);
      allowModel(principal, model);
      const { body: clean, output } = await applyGuardrails(body, principal);
      const parsed = parseRequest(messagesRequestSchema, clean);
      if (!parsed.ok) {
        throw new GateError(400, "invalid_request", parsed.message, { param: parsed.param });
      }
      const input = {
        principal,
        model,
        body: clean,
        request: parsed.data,
        aliases: modelChain(principal, model, clean),
        outputGuard: output,
        headers: anthropicPassthroughHeaders(req.headers),
      };
      if (parsed.data.stream === true) return await streamMessages({ ...input, req });
      return NextResponse.json(await dispatchMessages(input));
    } catch (err) {
      return gateResponse(err, req);
    }
  };
}
