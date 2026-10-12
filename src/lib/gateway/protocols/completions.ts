import { GateError, openAIErrorBody } from "@/lib/gateway/errors";
import { asRecord, stringifyContent } from "@/lib/gateway/core";
import { sseData } from "@/lib/gateway/protocols/sse";
import type { JsonMap } from "@/types/gateway";
import type {
  ChatStreamEncoder,
  CompletionContext,
  CompletionsRequest,
  CompletionStreamContext,
} from "@/types/responses";

export function completionPrompts(request: CompletionsRequest): string[] {
  return typeof request.prompt === "string" ? [request.prompt] : request.prompt;
}

export function completionToChat(request: CompletionsRequest, prompt: string): JsonMap {
  const body: JsonMap = { model: request.model, messages: [{ role: "user", content: prompt }] };
  const passthrough = [
    "max_tokens",
    "temperature",
    "top_p",
    "n",
    "stop",
    "presence_penalty",
    "frequency_penalty",
    "logit_bias",
    "user",
    "seed",
  ] as const;
  for (const key of passthrough) {
    const value = request[key];
    if (value !== undefined && value !== null) body[key] = value;
  }
  if (request.stream === true) {
    body.stream = true;
    if (request.stream_options) body.stream_options = request.stream_options;
  }
  return body;
}

function completionFinish(reason: unknown): string | null {
  if (reason === "length" || reason === "content_filter") return reason;
  if (reason == null || reason === "") return null;
  return "stop";
}

export function chatToCompletion(chats: JsonMap[], ctx: CompletionContext): JsonMap {
  const choices: JsonMap[] = [];
  let prompt = 0;
  let completion = 0;
  chats.forEach((chat, promptIndex) => {
    const list = Array.isArray(chat.choices) ? chat.choices : [];
    for (const raw of list) {
      const choice = asRecord(raw);
      if (!choice) continue;
      const text = stringifyContent(asRecord(choice.message)?.content);
      choices.push({
        text: ctx.echo ? `${ctx.prompts[promptIndex] ?? ""}${text}` : text,
        index: promptIndex * ctx.n + (Number(choice.index ?? 0) || 0),
        logprobs: null,
        finish_reason: completionFinish(choice.finish_reason) ?? "stop",
      });
    }
    const usage = asRecord(chat.usage);
    prompt += Number(usage?.prompt_tokens ?? 0) || 0;
    completion += Number(usage?.completion_tokens ?? 0) || 0;
  });
  choices.sort((a, b) => Number(a.index) - Number(b.index));
  return {
    id: ctx.id,
    object: "text_completion",
    created: ctx.created,
    model: ctx.model,
    choices,
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  };
}

export class CompletionStreamEncoder implements ChatStreamEncoder {
  constructor(private ctx: CompletionStreamContext) {}

  private chunk(extra: JsonMap): string {
    return sseData({
      id: this.ctx.id,
      object: "text_completion",
      created: this.ctx.created,
      model: this.ctx.model,
      ...extra,
    });
  }

  start(): string[] {
    if (!this.ctx.echo) return [];
    return [this.chunk({ choices: [{ text: this.ctx.echo, index: 0, logprobs: null, finish_reason: null }] })];
  }

  push(chunk: JsonMap): string[] {
    const out: string[] = [];
    const list = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choices: JsonMap[] = [];
    for (const raw of list) {
      const choice = asRecord(raw);
      if (!choice) continue;
      const delta = asRecord(choice.delta);
      const text = typeof delta?.content === "string" ? delta.content : "";
      const finish = completionFinish(choice.finish_reason);
      if (!text && !finish) continue;
      choices.push({ text, index: Number(choice.index ?? 0) || 0, logprobs: null, finish_reason: finish });
    }
    if (choices.length) out.push(this.chunk({ choices }));
    const usage = asRecord(chunk.usage);
    if (usage) {
      const prompt = Number(usage.prompt_tokens ?? 0) || 0;
      const completion = Number(usage.completion_tokens ?? 0) || 0;
      out.push(
        this.chunk({
          choices: [],
          usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
        }),
      );
    }
    return out;
  }

  finish(): string[] {
    return [sseData("[DONE]")];
  }

  fail(message: string): string[] {
    return [sseData(openAIErrorBody(new GateError(502, "upstream_error", message))), sseData("[DONE]")];
  }
}
