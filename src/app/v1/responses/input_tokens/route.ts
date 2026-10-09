import { NextResponse } from "next/server";
import { anthropicCountBody, chatToAnthropic } from "@/lib/gateway/anthropic";
import { withDeployment } from "@/lib/gateway/chat";
import { deploymentAuth } from "@/lib/gateway/credentials";
import { asNumber, asRecord } from "@/lib/gateway/core";
import { resolveResponsesFiles } from "@/lib/gateway/file-refs";
import { allowModel, applyPii, gateRequest, gateResponse, modelChain, modelOf, readBody } from "@/lib/gateway/gate";
import { GateError } from "@/lib/gateway/errors";
import { parseRequest, responsesCountBody, responsesToChat } from "@/lib/gateway/responses";
import { previousConversation } from "@/lib/gateway/responses-store";
import { requestRoutingOverride } from "@/lib/gateway/service-mode";
import { proxyJson, upstreamError } from "@/lib/gateway/upstream";
import { responsesRequestSchema } from "@/schemas/responses";

export async function POST(req: Request) {
  try {
    const principal = await gateRequest(req);
    const body = await readBody(req);
    const model = modelOf(body);
    allowModel(principal, model);
    const { body: redacted } = await applyPii(body, principal);
    const clean = await resolveResponsesFiles(redacted, principal);
    const parsed = parseRequest(responsesRequestSchema, clean);
    if (!parsed.ok) {
      throw new GateError(400, "invalid_request", parsed.message, { param: parsed.param });
    }
    const request = parsed.data;
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
  } catch (err) {
    return gateResponse(err, req);
  }
}
