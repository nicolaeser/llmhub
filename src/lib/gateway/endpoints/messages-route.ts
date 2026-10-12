import "server-only";
import { NextResponse } from "next/server";
import { modelChain } from "@/lib/gateway/access/gate";
import { gatewayRoute, screenModelRequest, validRequest } from "@/lib/gateway/endpoints/pipeline";
import { anthropicPassthroughHeaders, apiKeyRequest } from "@/lib/gateway/protocols/messages";
import { dispatchMessages, streamMessages } from "@/lib/gateway/dispatch/messages-dispatch";
import { messagesRequestSchema } from "@/schemas/anthropic";
import type { RoutePool } from "@/types/gateway";

export function messagesRoute(pool: RoutePool) {
  return gatewayRoute(async (req) => {
    const { principal, model, clean, output } = await screenModelRequest(req, { pool, auth: apiKeyRequest(req) });
    const request = validRequest(messagesRequestSchema, clean);
    const input = {
      principal,
      model,
      body: clean,
      request,
      aliases: modelChain(principal, model, clean),
      outputGuard: output,
      headers: anthropicPassthroughHeaders(req.headers),
    };
    if (request.stream === true) return streamMessages({ ...input, req });
    return NextResponse.json(await dispatchMessages(input));
  });
}
