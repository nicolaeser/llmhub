import { asRecord, asString } from "@/lib/gateway/core";
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

export function withAnthropicModelParams(model: string, body: JsonMap): JsonMap {
  const adjusted = anthropicParamsFor(model, body);
  if (adjusted.adjustments.length) {
    logger.info("gateway.anthropic_params_adjusted", { model, adjustments: adjusted.adjustments });
  }
  return adjusted.body;
}
