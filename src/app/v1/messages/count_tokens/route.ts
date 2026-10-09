import { NextResponse } from "next/server";
import { anthropicCountBody } from "@/lib/gateway/anthropic";
import { deploymentKey, withDeployment } from "@/lib/gateway/chat";
import { asNumber, asRecord } from "@/lib/gateway/core";
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
import {
  anthropicPassthroughHeaders,
  apiKeyRequest,
  chatIncompatibility,
  messagesToChat,
} from "@/lib/gateway/messages";
import { chatToResponsesCountBody, parseRequest } from "@/lib/gateway/responses";
import { requestRoutingOverride } from "@/lib/gateway/service-mode";
import { proxyJson, upstreamError } from "@/lib/gateway/upstream";
import { messagesRequestSchema } from "@/schemas/anthropic";

export async function POST(req: Request) {
  try {
    const principal = await gateRequest(apiKeyRequest(req));
    const body = await readBody(req);
    const model = modelOf(body);
    allowModel(principal, model);
    const { body: clean } = await applyGuardrails(body, principal);
    const parsed = parseRequest(messagesRequestSchema, clean);
    if (!parsed.ok) {
      throw new GateError(400, "invalid_request", parsed.message, { param: parsed.param });
    }
    const routed = await withDeployment(
      modelChain(principal, model, clean),
      principal.routeLimits,
      async (dep, group) => {
        const anthropic = dep.kind === "anthropic";
        if (!anthropic) {
          const issue = chatIncompatibility(parsed.data);
          if (issue) throw new GateError(400, "unsupported_parameter", issue);
        }
        const proxied = await proxyJson({
          dep,
          apiKey: deploymentKey(dep),
          path: anthropic ? "/v1/messages/count_tokens" : "/responses/input_tokens",
          body: anthropic
            ? anthropicCountBody(clean)
            : chatToResponsesCountBody(messagesToChat(parsed.data), dep.model || model),
          groupStrategy: group.strategy,
          headers: anthropic ? anthropicPassthroughHeaders(req.headers) : undefined,
        });
        if (proxied.status >= 400) throw upstreamError(proxied.status, proxied.json);
        return asNumber(asRecord(proxied.json)?.input_tokens, 0);
      },
      { strategy: requestRoutingOverride(clean) },
    );
    return NextResponse.json({ input_tokens: routed.result });
  } catch (err) {
    return gateResponse(err, req);
  }
}
