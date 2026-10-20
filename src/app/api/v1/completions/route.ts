import { NextResponse } from "next/server";
import { dispatchChat, streamChat } from "@/lib/gateway/dispatch/chat";
import { restoreClientJson, restoreClientChatStream } from "@/lib/gateway/safety/restore-client";
import { modelChain } from "@/lib/gateway/access/gate";
import { gatewayRoute, screenModelRequest, validRequest } from "@/lib/gateway/endpoints/pipeline";
import { GateError } from "@/lib/gateway/errors";
import {
  chatToCompletion,
  completionPrompts,
  CompletionStreamEncoder,
  completionToChat,
} from "@/lib/gateway/protocols/completions";
import { pipeChatStream } from "@/lib/gateway/protocols/chat-stream";
import { newId } from "@/lib/gateway/core";
import { completionsRequestSchema } from "@/schemas/completions";

export const maxDuration = 300;

export const POST = gatewayRoute(async (req) => {
  const { principal, model, clean, output } = await screenModelRequest(req);
  const request = validRequest(completionsRequestSchema, clean);
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
      outputGuard: output,
    });
    return restoreClientChatStream(
      principal.trace,
      pipeChatStream(streamed, new CompletionStreamEncoder({ id, created, model, echo: request.echo ? prompt : "" })),
    );
  }
  const results = await Promise.all(
    prompts.map((prompt) =>
      dispatchChat({
        principal,
        model,
        body: completionToChat(request, prompt),
        aliases,
        outputGuard: output,
      }),
    ),
  );
  return NextResponse.json(
    restoreClientJson(
      principal.trace,
      chatToCompletion(results.map((result) => result.json), {
        id,
        created,
        model,
        n: request.n ?? 1,
        prompts,
        echo: request.echo === true,
      }),
    ),
  );
});
