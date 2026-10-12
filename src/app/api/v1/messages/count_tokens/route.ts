import { NextResponse } from "next/server";
import { anthropicCountBody } from "@/lib/gateway/protocols/anthropic";
import { withDeployment } from "@/lib/gateway/dispatch/chat";
import { deploymentAuth } from "@/lib/gateway/upstreams/credentials";
import { asNumber, asRecord } from "@/lib/gateway/core";
import { modelChain } from "@/lib/gateway/access/gate";
import { gatewayRoute, screenModelRequest, validRequest } from "@/lib/gateway/endpoints/pipeline";
import { GateError } from "@/lib/gateway/errors";
import {
  anthropicPassthroughHeaders,
  apiKeyRequest,
  chatIncompatibility,
  messagesToChat,
} from "@/lib/gateway/protocols/messages";
import { chatToResponsesCountBody } from "@/lib/gateway/protocols/responses";
import { requestRoutingOverride } from "@/lib/gateway/dispatch/service-mode";
import { proxyJson, upstreamError } from "@/lib/gateway/dispatch/upstream";
import { messagesRequestSchema } from "@/schemas/anthropic";

export const POST = gatewayRoute(async (req) => {
  const { principal, model, clean } = await screenModelRequest(req, { auth: apiKeyRequest(req) });
  const request = validRequest(messagesRequestSchema, clean);
  const routed = await withDeployment(
    modelChain(principal, model, clean),
    principal.routeLimits,
    async (dep, group) => {
      const anthropic = dep.kind === "anthropic";
      if (!anthropic) {
        const issue = chatIncompatibility(request);
        if (issue) throw new GateError(400, "unsupported_parameter", issue);
      }
      const proxied = await proxyJson({
        dep,
        auth: await deploymentAuth(dep),
        path: anthropic ? "/v1/messages/count_tokens" : "/responses/input_tokens",
        body: anthropic
          ? anthropicCountBody(clean)
          : chatToResponsesCountBody(messagesToChat(request), dep.model || model),
        groupStrategy: group.strategy,
        headers: anthropic ? anthropicPassthroughHeaders(req.headers) : undefined,
      });
      if (proxied.status >= 400) throw upstreamError(proxied.status, proxied.json);
      return asNumber(asRecord(proxied.json)?.input_tokens, 0);
    },
    { strategy: requestRoutingOverride(clean) },
  );
  return NextResponse.json({ input_tokens: routed.result });
});
