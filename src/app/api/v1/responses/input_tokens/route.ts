import { NextResponse } from "next/server";
import { anthropicCountBody, chatToAnthropic } from "@/lib/gateway/protocols/anthropic";
import { withDeployment } from "@/lib/gateway/dispatch/chat";
import { deploymentAuth } from "@/lib/gateway/upstreams/credentials";
import { asNumber, asRecord } from "@/lib/gateway/core";
import { resolveResponsesFiles } from "@/lib/gateway/storage/file-refs";
import { modelChain } from "@/lib/gateway/access/gate";
import { gatewayRoute, screenModelRequest, validRequest } from "@/lib/gateway/endpoints/pipeline";
import { responsesCountBody, responsesToChat } from "@/lib/gateway/protocols/responses";
import { previousConversation } from "@/lib/gateway/storage/responses-store";
import { requestRoutingOverride } from "@/lib/gateway/dispatch/service-mode";
import { proxyJson, upstreamError } from "@/lib/gateway/dispatch/upstream";
import { responsesRequestSchema } from "@/schemas/responses";

export const POST = gatewayRoute(async (req) => {
  const { principal, model, clean: redacted } = await screenModelRequest(req);
  const clean = await resolveResponsesFiles(redacted, principal);
  const request = validRequest(responsesRequestSchema, clean);
  const history = request.previous_response_id
    ? await previousConversation(request.previous_response_id, principal)
    : [];
  const routed = await withDeployment(
    modelChain(principal, model, clean),
    principal.routeLimits,
    async (dep, group) => {
      const anthropic = dep.kind === "anthropic";
      const proxied = await proxyJson({
        dep,
        auth: await deploymentAuth(dep),
        path: anthropic ? "/v1/messages/count_tokens" : "/responses/input_tokens",
        body: anthropic
          ? anthropicCountBody(chatToAnthropic({ ...responsesToChat(request, history).body, model: dep.model || model }))
          : responsesCountBody(clean, request, history),
        groupStrategy: group.strategy,
      });
      if (proxied.status >= 400) throw upstreamError(proxied.status, proxied.json);
      return asNumber(asRecord(proxied.json)?.input_tokens, 0);
    },
    { strategy: requestRoutingOverride(clean) },
  );
  return NextResponse.json({ object: "response.input_tokens", input_tokens: routed.result });
});
