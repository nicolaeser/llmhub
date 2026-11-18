import { asString } from "@/lib/gateway/core";
import { setsCacheControl, withinCacheBreakpointLimit } from "@/lib/gateway/protocols/anthropic";
import type { JsonMap } from "@/types/gateway";

export const XAI_CONVERSATION_HEADER = "x-grok-conv-id";
const CONVERSATION_HEADER_KINDS = new Set(["xai", "grok_build"]);
const OPENROUTER_KINDS = new Set(["openrouter", "openrouter_eu"]);
const CLAUDE_MODEL = /(?:^|\/)claude-/i;

export function promptCacheHeaders(kind: string, body: JsonMap): Record<string, string> {
  const key = asString(body.prompt_cache_key).trim();
  return key && CONVERSATION_HEADER_KINDS.has(kind) ? { [XAI_CONVERSATION_HEADER]: key } : {};
}

export function withOpenRouterClaudeCache(kind: string, body: JsonMap): JsonMap {
  if (!OPENROUTER_KINDS.has(kind) || !CLAUDE_MODEL.test(asString(body.model))) return body;
  if (setsCacheControl(body)) return withinCacheBreakpointLimit(body);
  return { ...body, cache_control: { type: "ephemeral" } };
}
