import { asRecord, asString } from "@/lib/gateway/core";
import { strictAnthropicVersion } from "@/lib/gateway/protocols/anthropic-version";
import { logger } from "@/lib/logging/logger";
import type { JsonMap } from "@/types/gateway";

type ThinkingOffForm = "omit" | "between_tools" | "disabled_up_to_high" | "disabled";

type ModelParamRules = { thinkingOff: ThinkingOffForm; acceptsForcedTool: boolean };

export type AnthropicParamsResult = { body: JsonMap; adjustments: string[] };

const ALWAYS_THINKING: ModelParamRules = { thinkingOff: "omit", acceptsForcedTool: false };
const ALWAYS_THINKING_FORCED_TOOL: ModelParamRules = { thinkingOff: "omit", acceptsForcedTool: true };
const THINKING_OFF_UP_TO_HIGH: ModelParamRules = { thinkingOff: "disabled_up_to_high", acceptsForcedTool: true };
const THINKING_OFF_ANY_EFFORT: ModelParamRules = { thinkingOff: "disabled", acceptsForcedTool: true };

const MODEL_RULES: Record<string, ModelParamRules> = {
  "claude-opus-5-5": ALWAYS_THINKING,
  "claude-fable-5-1": ALWAYS_THINKING,
  "claude-mythos-5-1": ALWAYS_THINKING,
  "claude-fable-5": ALWAYS_THINKING_FORCED_TOOL,
  "claude-mythos-5": ALWAYS_THINKING_FORCED_TOOL,
  "claude-sonnet-5-5": { thinkingOff: "between_tools", acceptsForcedTool: false },
  "claude-opus-5": THINKING_OFF_UP_TO_HIGH,
  "claude-haiku-5-5": THINKING_OFF_UP_TO_HIGH,
  "claude-opus-4-8": THINKING_OFF_ANY_EFFORT,
  "claude-opus-4-7": THINKING_OFF_ANY_EFFORT,
  "claude-sonnet-5": THINKING_OFF_ANY_EFFORT,
};

const SAMPLING_KEYS = ["temperature", "top_p", "top_k"] as const;
const CITATION_CONTAINERS = new Set(["search_result", "tool_result"]);
const THINKING_OFF_TYPES = new Set(["disabled", "between_tools"]);
const EFFORTS_ABOVE_HIGH = new Set(["xhigh", "max"]);
const LOWEST_EFFORT = "low";
const BUDGET_EFFORTS: { below: number; effort: string }[] = [
  { below: 4096, effort: "low" },
  { below: 16384, effort: "medium" },
  { below: 32768, effort: "high" },
];
const LARGEST_BUDGET_EFFORT = "xhigh";

function anthropicBaseModel(model: string): string {
  const id = model.trim().toLowerCase();
  const start = id.lastIndexOf("claude-");
  if (start < 0) return "";
  return id
    .slice(start)
    .replace(/\[[^\]]*\]/g, "")
    .replace(/[@:].*$/, "")
    .replace(/-v\d+$/, "")
    .replace(/-\d{8}$/, "")
    .replace(/\./g, "-");
}

function budgetEffort(budget: number): string {
  return BUDGET_EFFORTS.find((step) => budget < step.below)?.effort ?? LARGEST_BUDGET_EFFORT;
}

function thinkingOffConfig(form: ThinkingOffForm, effortAboveHigh: boolean): JsonMap | null {
  if (form === "omit") return null;
  if (form === "between_tools") return effortAboveHigh ? null : { type: "between_tools" };
  if (form === "disabled_up_to_high" && effortAboveHigh) return null;
  return { type: "disabled" };
}

function sameThinking(current: JsonMap, next: JsonMap): boolean {
  if (current.type !== next.type) return false;
  return next.type !== "between_tools" || Object.keys(current).length === 1;
}

export function anthropicParamsFor(model: string, body: JsonMap): AnthropicParamsResult {
  const rules = MODEL_RULES[anthropicBaseModel(model)];
  if (!rules) return { body, adjustments: [] };
  const out: JsonMap = { ...body };
  const adjustments: string[] = [];
  const outputConfig = asRecord(body.output_config);
  const effort = asString(outputConfig?.effort);
  const setEffort = (level: string) => {
    out.output_config = { ...(outputConfig ?? {}), effort: level };
    adjustments.push(`effort:${level}`);
  };

  const thinking = asRecord(body.thinking);
  const thinkingType = asString(thinking?.type);
  if (thinking && THINKING_OFF_TYPES.has(thinkingType)) {
    const replacement = thinkingOffConfig(rules.thinkingOff, EFFORTS_ABOVE_HIGH.has(effort));
    if (!replacement) {
      delete out.thinking;
      adjustments.push("thinking:omitted");
      if (!effort) setEffort(LOWEST_EFFORT);
    } else if (!sameThinking(thinking, replacement)) {
      out.thinking = replacement;
      adjustments.push(`thinking:${asString(replacement.type)}`);
    }
  } else if (thinking && thinkingType === "enabled") {
    const adaptive: JsonMap = { type: "adaptive" };
    if (typeof thinking.display === "string") adaptive.display = thinking.display;
    out.thinking = adaptive;
    adjustments.push("thinking:adaptive");
    if (!effort && typeof thinking.budget_tokens === "number") setEffort(budgetEffort(thinking.budget_tokens));
  }

  for (const key of SAMPLING_KEYS) {
    if (!(key in out)) continue;
    delete out[key];
    adjustments.push(`${key}:dropped`);
  }

  const toolChoice = asRecord(body.tool_choice);
  if (!rules.acceptsForcedTool && (toolChoice?.type === "any" || toolChoice?.type === "tool")) {
    const auto: JsonMap = { type: "auto" };
    if (typeof toolChoice.disable_parallel_tool_use === "boolean") {
      auto.disable_parallel_tool_use = toolChoice.disable_parallel_tool_use;
    }
    out.tool_choice = auto;
    adjustments.push("tool_choice:auto");
  }

  return { body: adjustments.length ? out : body, adjustments };
}

function isDocument(block: unknown): boolean {
  return asRecord(block)?.type === "document";
}

function userBlocks(content: unknown): unknown[] {
  if (Array.isArray(content)) return content;
  return typeof content === "string" && content ? [{ type: "text", text: content }] : [];
}

function withAssistantDocumentsInUserTurns(messages: unknown[]): { messages: unknown[]; moved: boolean } {
  const out: unknown[] = [];
  let moved = false;
  for (const raw of messages) {
    const message = asRecord(raw);
    if (message?.role !== "assistant" || !Array.isArray(message.content) || !message.content.some(isDocument)) {
      out.push(raw);
      continue;
    }
    moved = true;
    const documents = message.content.filter(isDocument);
    const rest = message.content.filter((block) => !isDocument(block));
    const previous = asRecord(out.at(-1));
    if (previous?.role === "user") {
      out[out.length - 1] = { ...previous, content: [...userBlocks(previous.content), ...documents] };
    } else {
      out.push({ role: "user", content: documents });
    }
    if (rest.length) out.push({ ...message, content: rest });
  }
  return { messages: out, moved };
}

function withoutCitations(block: unknown): unknown {
  const rec = asRecord(block);
  if (!rec) return block;
  if (rec.type === "text" && Array.isArray(rec.citations) && rec.citations.length) {
    const out: JsonMap = { ...rec };
    delete out.citations;
    return out;
  }
  if (!CITATION_CONTAINERS.has(asString(rec.type)) || !Array.isArray(rec.content)) return block;
  const nested = rec.content;
  const content = nested.map(withoutCitations);
  return content.some((item, index) => item !== nested[index]) ? { ...rec, content } : block;
}

function withoutUserCitations(messages: unknown[]): { messages: unknown[]; dropped: boolean } {
  let dropped = false;
  const out = messages.map((raw) => {
    const message = asRecord(raw);
    if (message?.role !== "user" || !Array.isArray(message.content)) return raw;
    const blocks = message.content;
    const content = blocks.map(withoutCitations);
    if (content.every((block, index) => block === blocks[index])) return raw;
    dropped = true;
    return { ...message, content };
  });
  return { messages: out, dropped };
}

export function anthropicVersionParams(version: string | null, body: JsonMap): AnthropicParamsResult {
  if (!strictAnthropicVersion(version)) return { body, adjustments: [] };
  const out: JsonMap = { ...body };
  const adjustments: string[] = [];
  for (const key of SAMPLING_KEYS) {
    if (!(key in out)) continue;
    delete out[key];
    adjustments.push(`${key}:dropped`);
  }
  if (Array.isArray(body.messages)) {
    const documents = withAssistantDocumentsInUserTurns(body.messages);
    const citations = withoutUserCitations(documents.messages);
    if (documents.moved) adjustments.push("assistant_documents:moved");
    if (citations.dropped) adjustments.push("user_citations:dropped");
    if (documents.moved || citations.dropped) out.messages = citations.messages;
  }
  return { body: adjustments.length ? out : body, adjustments };
}

export function withAnthropicModelParams(model: string, body: JsonMap, version: string | null = null): JsonMap {
  const fitted = anthropicParamsFor(model, body);
  const versioned = anthropicVersionParams(version, fitted.body);
  const adjustments = [...fitted.adjustments, ...versioned.adjustments];
  if (adjustments.length) {
    logger.info("gateway.anthropic_params_adjusted", version ? { model, version, adjustments } : { model, adjustments });
  }
  return versioned.body;
}
