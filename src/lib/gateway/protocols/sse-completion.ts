import { asRecord, asString } from "@/lib/gateway/core";
import { GateError } from "@/lib/gateway/errors";
import { ChatStreamTranscript } from "@/lib/gateway/request-logs/log-content";
import type { ChatSseTranslator, JsonMap } from "@/types/gateway";

export function completionFromChunks(chunks: Iterable<string>, model: string): JsonMap {
  const transcript = new ChatStreamTranscript();
  const thinking: JsonMap[] = [];
  const searches: JsonMap[] = [];
  let last: JsonMap | null = null;
  const records = (value: unknown) =>
    (Array.isArray(value) ? value : []).map(asRecord).filter((item): item is JsonMap => item !== null);
  for (const payload of chunks) {
    const chunk = JSON.parse(payload) as JsonMap;
    transcript.push(chunk);
    const delta = asRecord(asRecord((Array.isArray(chunk.choices) ? chunk.choices : [])[0])?.delta);
    thinking.push(...records(delta?.thinking_blocks));
    searches.push(...records(delta?.web_search_calls));
    last = chunk;
  }
  const final = asRecord(last);
  const choice = asRecord((Array.isArray(final?.choices) ? final.choices : [])[0]);
  const finish = asString(choice?.finish_reason);
  if (!final || !finish) throw new GateError(502, "upstream_error", "upstream stream ended before the response completed");
  const result = transcript.result();
  const assembled = Array.isArray(result?.choices) ? asRecord(result.choices[0]) : null;
  const message = asRecord(assembled?.message) ?? { role: "assistant", content: "" };
  if (thinking.length) message.thinking_blocks = thinking;
  if (searches.length) message.web_search_calls = searches;
  return {
    id: final.id,
    object: "chat.completion",
    created: final.created,
    model,
    choices: [{ index: 0, message, logprobs: null, finish_reason: finish }],
    usage: final.usage,
  };
}

function* translated(translator: ChatSseTranslator, text: string): Generator<string> {
  for (const line of text.split("\n")) yield* translator.pushLine(line);
  const flushed = translator.flush();
  if (flushed) yield flushed;
}

export function completionFromSse(translator: ChatSseTranslator, text: string, model: string): JsonMap {
  return completionFromChunks(translated(translator, text), model);
}
