import "server-only";
import { NextResponse } from "next/server";
import { modelChain } from "@/lib/gateway/access/gate";
import { gatewayRoute, screenModelRequest, validRequest } from "@/lib/gateway/endpoints/pipeline";
import { anthropicPassthroughHeaders, apiKeyRequest } from "@/lib/gateway/protocols/messages";
import { dispatchMessages, streamMessages } from "@/lib/gateway/dispatch/messages-dispatch";
import { messagesRequestSchema } from "@/schemas/anthropic";
import { maxCostHeader } from "@/lib/gateway/billing/cost-cap";
import { messagesToolNames, runMcpMessages, streamMcpMessages, withMcpMessagesTools } from "@/lib/mcp/messages-loop";
import { mcpToolsetFor } from "@/lib/mcp/toolset";
import type { RoutePool } from "@/types/routing";

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
    const toolset = await mcpToolsetFor(req, principal, messagesToolNames(clean));
    if (toolset) {
      const ctx = {
        principal,
        model,
        aliases: input.aliases,
        outputGuard: output,
        toolset,
        maxCost: maxCostHeader(req.headers),
        signal: req.signal,
      };
      const body = withMcpMessagesTools(clean, toolset);
      if (request.stream === true) return streamMcpMessages({ req, ctx, body, headers: input.headers });
      return NextResponse.json(await runMcpMessages(ctx, body, input.headers));
    }
    if (request.stream === true) return streamMessages({ ...input, req });
    return NextResponse.json(await dispatchMessages(input));
  });
}
