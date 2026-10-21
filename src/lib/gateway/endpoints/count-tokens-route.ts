import "server-only";
import { NextResponse } from "next/server";
import { modelChain } from "@/lib/gateway/access/gate";
import { asNumber, asRecord, stringifyContent } from "@/lib/gateway/core";
import { estimateTokens } from "@/lib/gateway/billing/tokens";
import { withDeployment } from "@/lib/gateway/dispatch/chat";
import { requestRoutingOverride } from "@/lib/gateway/dispatch/service-mode";
import { proxyJson, upstreamError } from "@/lib/gateway/dispatch/upstream";
import { gatewayRoute, screenModelRequest, validRequest } from "@/lib/gateway/endpoints/pipeline";
import { GateError } from "@/lib/gateway/errors";
import { anthropicCountBody, nativeMessagesBody } from "@/lib/gateway/protocols/anthropic";
import {
  anthropicPassthroughHeaders,
  apiKeyRequest,
  chatIncompatibility,
  messagesToChat,
} from "@/lib/gateway/protocols/messages";
import { chatToResponsesCountBody } from "@/lib/gateway/protocols/responses";
import { deploymentAuth } from "@/lib/gateway/upstreams/credentials";
import { isSignInKind, speaksAnthropic, speaksGoogle, speaksMuse } from "@/lib/gateway/upstreams/provider-kinds";
import { messagesRequestSchema } from "@/schemas/anthropic";
import type { JsonMap } from "@/types/gateway";
import type { PublicPool } from "@/types/routing";

function estimatedInputTokens(chat: JsonMap): number {
  const messages = Array.isArray(chat.messages) ? chat.messages : [];
  const parts = messages.map((message) => stringifyContent(asRecord(message)?.content));
  for (const raw of messages) {
    const calls = asRecord(raw)?.tool_calls;
    if (Array.isArray(calls)) parts.push(JSON.stringify(calls));
  }
  if (Array.isArray(chat.tools)) parts.push(JSON.stringify(chat.tools));
  return estimateTokens(parts.filter(Boolean).join("\n"));
}

export function countTokensRoute(pool: PublicPool) {
  return gatewayRoute(async (req) => {
    const { principal, model, clean } = await screenModelRequest(req, { pool, auth: apiKeyRequest(req) });
    const request = validRequest(messagesRequestSchema, clean);
    const routed = await withDeployment(
      modelChain(principal, model, clean),
      principal.routeLimits,
      async (dep, group) => {
        if (speaksAnthropic(dep.kind)) {
          const proxied = await proxyJson({
            dep,
            auth: await deploymentAuth(dep),
            path: "/v1/messages/count_tokens",
            body: anthropicCountBody(nativeMessagesBody(clean)),
            groupStrategy: group.strategy,
            headers: anthropicPassthroughHeaders(req.headers),
          });
          if (proxied.status >= 400) throw upstreamError(proxied.status, proxied.json, proxied.headers);
          return asNumber(asRecord(proxied.json)?.input_tokens, 0);
        }
        const issue = chatIncompatibility(request, { webSearch: dep.kind === "codex" || speaksMuse(dep.kind) });
        if (issue) throw new GateError(400, "unsupported_parameter", issue);
        const chat = messagesToChat(request);
        if (isSignInKind(dep.kind) || speaksGoogle(dep.kind)) return estimatedInputTokens(chat);
        const proxied = await proxyJson({
          dep,
          auth: await deploymentAuth(dep),
          path: "/responses/input_tokens",
          body: chatToResponsesCountBody(chat, dep.model || model),
          groupStrategy: group.strategy,
        });
        if (proxied.status >= 400) throw upstreamError(proxied.status, proxied.json, proxied.headers);
        return asNumber(asRecord(proxied.json)?.input_tokens, 0);
      },
      { strategy: requestRoutingOverride(clean), pool, principal, request: clean },
    );
    return NextResponse.json({ input_tokens: routed.result });
  });
}
