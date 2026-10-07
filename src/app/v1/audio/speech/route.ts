import { allowModel, applyPii, gateRequest, gateResponse, modelOf, readBody, modelChain } from "@/lib/gateway/gate";
import { meter } from "@/lib/gateway/meter";
import { estimateTokens } from "@/lib/gateway/tokens";
import { bytesBody } from "@/lib/http/api";
import { forwardToModel } from "@/lib/gateway/upstream";

export async function POST(req: Request) {
  try {
    const principal = await gateRequest(req);
    const body = await readBody(req);
    const model = modelOf(body);
    allowModel(principal, model);
    const { body: clean } = await applyPii(body, principal);
    const aliases = modelChain(principal, model, clean);
    const usage = meter(principal, model, body);
    try {
      const hit = await forwardToModel(aliases, principal.routeLimits, "/audio/speech", clean, { binary: true });
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
  } catch (err) {
    return gateResponse(err, req);
  }
}
