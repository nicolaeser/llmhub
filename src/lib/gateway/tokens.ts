import { asRecord, stringifyContent } from "@/lib/gateway/core";
import type { JsonMap } from "@/types/gateway";

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function requestText(body: JsonMap): string {
  if (typeof body.prompt === "string") return body.prompt;
  if (typeof body.input === "string") return body.input;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages
    .map((message) => stringifyContent(asRecord(message)?.content))
    .filter(Boolean)
    .join("\n");
}
