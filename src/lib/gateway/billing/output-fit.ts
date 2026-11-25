import { asRecord } from "@/lib/gateway/core";
import { OUTPUT_LIMIT_KEYS, outputTokenLimit, positiveInteger } from "@/lib/gateway/billing/tokens";
import type { JsonMap } from "@/types/gateway";
import type { OutputSnapshot } from "@/types/billing";

export const MIN_OUTPUT_TOKENS = 1024;
export const MIN_THINKING_TOKENS = 1024;
export const UNSTATED_OUTPUT_TOKENS = 32_000;

const CHOICE_KEYS = ["n", "best_of"] as const;
const COMPLETION_TOKEN_KINDS: ReadonlySet<string> = new Set(["openai"]);

export function requestChoices(body: JsonMap): number {
  return Math.max(1, ...CHOICE_KEYS.map((key) => positiveInteger(body[key])));
}

export function writesText(body: JsonMap): boolean {
  return Array.isArray(body.messages) || outputTokenLimit(body) > 0;
}

function thinkingBudget(body: JsonMap): number {
  const thinking = asRecord(body.thinking);
  return thinking?.type === "enabled" ? positiveInteger(thinking.budget_tokens) : 0;
}

export function outputFloor(body: JsonMap): number {
  return thinkingBudget(body) > 0 ? MIN_THINKING_TOKENS + MIN_OUTPUT_TOKENS : MIN_OUTPUT_TOKENS;
}

export function outputWanted(body: JsonMap): { perChoice: number; floorPerChoice: number } {
  if (!writesText(body)) return { perChoice: 0, floorPerChoice: 0 };
  const perChoice = outputTokenLimit(body) || UNSTATED_OUTPUT_TOKENS;
  return { perChoice, floorPerChoice: Math.min(perChoice, outputFloor(body)) };
}

export function snapshotOutput(body: JsonMap): OutputSnapshot {
  return {
    limits: OUTPUT_LIMIT_KEYS.filter((key) => key in body).map((key) => [key, body[key]]),
    thinking: "thinking" in body ? body.thinking : undefined,
  };
}

export function restoreOutput(body: JsonMap, snapshot: OutputSnapshot): void {
  for (const key of OUTPUT_LIMIT_KEYS) delete body[key];
  for (const [key, value] of snapshot.limits) body[key] = value;
  if (snapshot.thinking === undefined) delete body.thinking;
  else body.thinking = snapshot.thinking;
}

function unstatedLimitKey(body: JsonMap, kind: string): string {
  if (!Array.isArray(body.messages)) return "max_output_tokens";
  return COMPLETION_TOKEN_KINDS.has(kind) ? "max_completion_tokens" : "max_tokens";
}

export function limitOutput(body: JsonMap, perChoice: number, kind: string): void {
  const stated = OUTPUT_LIMIT_KEYS.filter((key) => positiveInteger(body[key]) > 0);
  if (stated.length) {
    for (const key of stated) body[key] = Math.min(positiveInteger(body[key]), perChoice);
  } else {
    body[unstatedLimitKey(body, kind)] = perChoice;
  }
  const budget = thinkingBudget(body);
  if (budget > 0 && budget >= perChoice) {
    body.thinking = {
      ...asRecord(body.thinking),
      budget_tokens: Math.max(MIN_THINKING_TOKENS, perChoice - MIN_OUTPUT_TOKENS),
    };
  }
}

export function grantedOutput(granted: number, base: number, wanted: number, perChoice: number): number {
  if (!(wanted > base) || granted >= wanted) return perChoice;
  return Math.max(0, Math.floor(((granted - base) / (wanted - base)) * perChoice));
}
