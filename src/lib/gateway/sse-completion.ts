import { asRecord, asString } from "@/lib/gateway/core";
import { GateError } from "@/lib/gateway/errors";
import { ChatStreamTranscript } from "@/lib/gateway/log-content";
import type { ChatSseTranslator, JsonMap } from "@/types/gateway";

export function completionFromSse(translator: ChatSseTranslator, text: string, model: string): JsonMap {
  const transcript = new ChatStreamTranscript();
  let last: JsonMap | null = null;
  const take = (payload: string) => {
    const chunk = JSON.parse(payload) as JsonMap;
    transcript.push(chunk);
    last = chunk;
  };
  for (const line of text.split("\n")) for (const payload of translator.pushLine(line)) take(payload);
  const flushed = translator.flush();
  if (flushed) take(flushed);
  const final = asRecord(last);
  const choice = asRecord((Array.isArray(final?.choices) ? final.choices : [])[0]);
  const finish = asString(choice?.finish_reason);
  if (!final || !finish) throw new GateError(502, "upstream_error", "upstream stream ended before the response completed");
  const result = transcript.result();
  const assembled = Array.isArray(result?.choices) ? asRecord(result.choices[0]) : null;
  const message = asRecord(assembled?.message) ?? { role: "assistant", content: "" };
  return {
    id: final.id,
    object: "chat.completion",
    created: final.created,
    model,
    choices: [{ index: 0, message, logprobs: null, finish_reason: finish }],
    usage: final.usage,
  };
}
