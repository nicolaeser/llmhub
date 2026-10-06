import { NextResponse } from "next/server";
import { dispatchChat, streamChat } from "@/lib/gateway/chat";
import {
  allowModel,
  applyPii,
  gateRequest,
  gateResponse,
  modelOf,
  readBody,
  modelChain,
} from "@/lib/gateway/gate";
import { GateError } from "@/lib/gateway/errors";
import {
  chatToCompletion,
  completionPrompts,
  CompletionStreamEncoder,
  completionToChat,
  parseRequest,
  pipeChatStream,
} from "@/lib/gateway/responses";
import { newId } from "@/lib/gateway/core";
import { completionsRequestSchema } from "@/schemas/completions";

export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const principal = await gateRequest(req);
    const body = await readBody(req);
    const model = modelOf(body);
    allowModel(principal, model);
    const { body: clean, output } = await applyPii(body, principal);
    const parsed = parseRequest(completionsRequestSchema, clean);
    if (!parsed.ok) {
      throw new GateError(400, "invalid_request", parsed.message, { param: parsed.param });
    }
    const request = parsed.data;
    const prompts = completionPrompts(request);
    const aliases = modelChain(principal, model, clean);
    const id = `cmpl-${newId()}`;
    const created = Math.floor(Date.now() / 1000);
    if (request.stream === true) {
      if (prompts.length > 1) {
        throw new GateError(400, "unsupported_parameter", "streaming supports a single prompt", {
          param: "prompt",
        });
      }
      const prompt = prompts[0] ?? "";
      const streamed = await streamChat({
        req,
        principal,
        model,
        body: completionToChat(request, prompt),
        aliases,
        outputPii: output,
      });
      return pipeChatStream(
        streamed,
        new CompletionStreamEncoder({ id, created, model, echo: request.echo ? prompt : "" }),
      );
    }
    const results = await Promise.all(
      prompts.map((prompt) =>
        dispatchChat({
          principal,
          model,
          body: completionToChat(request, prompt),
          aliases,
          outputPii: output,
        }),
      ),
    );
    return NextResponse.json(
      chatToCompletion(
        results.map((result) => result.json),
        { id, created, model, n: request.n ?? 1, prompts, echo: request.echo === true },
      ),
    );
  } catch (err) {
    return gateResponse(err, req);
  }
}
