import { asRecord, stringifyContent } from "@/lib/gateway/core";
import { isOpaqueText } from "@/lib/gateway/safety/pii";
import type { JsonMap } from "@/types/gateway";
import type { ContextDemand } from "@/types/routing";

const OUTPUT_LIMIT_KEYS = ["max_tokens", "max_completion_tokens", "max_output_tokens"] as const;
const NON_PROMPT_KEYS: ReadonlySet<string> = new Set([
  "model",
  "user",
  "metadata",
  "tags",
  "tag",
  "fallbacks",
  "fallback",
  "signature",
  "encrypted_content",
]);
const UNCOUNTED_CONTEXT_KEYS: ReadonlySet<string> = new Set([
  ...NON_PROMPT_KEYS,
  "thinking",
  "thinking_blocks",
  "reasoning_content",
  "reasoning_details",
]);

export function tokenCount(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

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

export function promptLength(value: unknown, skipped: ReadonlySet<string> = NON_PROMPT_KEYS, key = ""): number {
  if (skipped.has(key)) return 0;
  if (typeof value === "string") return isOpaqueText(value) ? 0 : value.length;
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + promptLength(item, skipped, key), 0);
  const rec = asRecord(value);
  if (!rec) return 0;
  return Object.entries(rec).reduce((sum, [field, item]) => sum + promptLength(item, skipped, field), 0);
}

export function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0;
}

export function outputTokenLimit(body: JsonMap): number {
  for (const key of OUTPUT_LIMIT_KEYS) {
    const limit = positiveInteger(body[key]);
    if (limit) return limit;
  }
  return 0;
}

export function contextDemand(body: JsonMap): ContextDemand {
  return {
    input: tokensForLength(promptLength(body, UNCOUNTED_CONTEXT_KEYS)),
    output: outputTokenLimit(body),
  };
}
