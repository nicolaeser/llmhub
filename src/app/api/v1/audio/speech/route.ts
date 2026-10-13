import { modelChain } from "@/lib/gateway/access/gate";
import { gatewayRoute, screenModelRequest } from "@/lib/gateway/endpoints/pipeline";
import { meter } from "@/lib/gateway/billing/meter";
import { estimateTokens } from "@/lib/gateway/billing/tokens";
import { bytesBody } from "@/lib/http/api";
import { forwardToModel } from "@/lib/gateway/dispatch/upstream";

export const POST = gatewayRoute(async (req) => {
  const { principal, model, body, clean } = await screenModelRequest(req);
  const aliases = modelChain(principal, model, clean);
  const usage = meter(principal, model, body);
  try {
    const hit = await forwardToModel(aliases, principal, "/audio/speech", clean, { binary: true });
    const input = typeof clean.input === "string" ? clean.input : "";
    await usage.ok(hit, { prompt_tokens: estimateTokens(input) });
    return new Response(bytesBody(hit.raw), {
      status: hit.status,
      headers: { "Content-Type": hit.contentType },
    });
  } catch (err) {
    await usage.fail(err);
    throw err;
  }
});
