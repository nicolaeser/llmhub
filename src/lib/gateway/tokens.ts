import { asRecord, stringifyContent } from "@/lib/gateway/core";
import type { JsonMap } from "@/types/gateway";

export function tokensForLength(length: number): number {
  return length > 0 ? Math.max(1, Math.ceil(length / 4)) : 0;
}

export function estimateTokens(text: string): number {
  return tokensForLength(text.length);
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
