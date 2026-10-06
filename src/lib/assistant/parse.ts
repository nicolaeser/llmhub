import "server-only";
import {
  asRecord,
  asString,
  stringifyContent
} from "@/lib/gateway/core";
import { redactPii } from "@/lib/gateway/pii";
import type { AssistantMessage, AssistantToolCall, AssistantLocale } from "@/types/assistant";
import type { JsonMap } from "@/types/gateway";

const MAX_MESSAGES = 20;
const MAX_CONTENT = 8000;
const MAX_REPLAY_RESULT_CHARS = 4000;
const MAX_REPLAY_TOTAL_CHARS = 24_000;
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

type ClientTurn = { role: "user" | "assistant"; rec: Record<string, unknown> };
type ReplayBudget = { left: number };

export function parseAssistantLocale(raw: unknown): AssistantLocale {
  return raw === "de" ? "de" : "en";
}

export function parseAssistantWrite(raw: unknown): boolean {
  return raw === true;
}

export function parseAssistantModel(raw: unknown): string {
  const value = asString(raw).trim();
  if (!value || value.length > 200 || value.includes("..")) return "";
  if (!/^[a-zA-Z0-9][\w./:+-]*$/.test(value)) return "";
  return value;
}

export function redactSecrets(text: string): string {
  return redactPii(text, ["SECRET", "JWT"]);
}

function clientText(raw: unknown): string {
  return stringifyContent(raw).trim().slice(0, MAX_CONTENT);
}

function replayResult(result: unknown, budget: ReplayBudget): string {
  const serialized = JSON.stringify(result) ?? "null";
  const room = Math.min(MAX_REPLAY_RESULT_CHARS, budget.left);
  if (room <= 0) return JSON.stringify({ omitted: true });
  budget.left -= Math.min(serialized.length, room);
  if (serialized.length <= room) return serialized;
  return JSON.stringify({ truncated: true, preview: serialized.slice(0, room) });
}

function replayAssistantParts(
  parts: unknown[],
  turn: number,
  budget: ReplayBudget,
): AssistantMessage[] {
  const out: AssistantMessage[] = [];
  let text = "";
  let calls: AssistantToolCall[] = [];
  let results: AssistantMessage[] = [];
  let sequence = 0;
  const flush = () => {
    if (calls.length) {
      out.push({ role: "assistant", content: text, toolCalls: calls }, ...results);
    } else if (text) {
      out.push({ role: "assistant", content: text });
    }
    text = "";
    calls = [];
    results = [];
  };
  for (const raw of parts) {
    const part = asRecord(raw);
    if (part?.type === "text") {
      if (calls.length) flush();
      const next = clientText(part.text);
      if (next) text = text ? `${text}\n\n${next}` : next;
      continue;
    }
    if (
      part?.type !== "tool" ||
      part.result === undefined ||
      typeof part.name !== "string" ||
      !TOOL_NAME.test(part.name)
    ) {
      continue;
    }
    const id = `call_h${turn}_${sequence}`;
    sequence += 1;
    calls.push({
      id,
      name: part.name,
      arguments: JSON.stringify(asRecord(part.args) ?? {}),
    });
    results.push({
      role: "tool",
      content: replayResult(part.result, budget),
      toolCallId: id,
      name: part.name,
    });
  }
  flush();
  return out;
}

function parseClientTurn(
  { role, rec }: ClientTurn,
  index: number,
  budget: ReplayBudget,
): AssistantMessage[] {
  if (role === "assistant" && Array.isArray(rec.parts)) {
    return replayAssistantParts(rec.parts, index, budget);
  }
  const content = clientText(rec.content);
  return content ? [{ role, content }] : [];
}

export function parseClientMessages(raw: unknown): AssistantMessage[] {
  if (!Array.isArray(raw)) return [];
  const items = raw.flatMap((item): ClientTurn[] => {
    const rec = asRecord(item);
    if (!rec || (rec.role !== "user" && rec.role !== "assistant")) return [];
    return [{ role: rec.role, rec }];
  });
  const budget: ReplayBudget = { left: MAX_REPLAY_TOTAL_CHARS };
  const turns: AssistantMessage[][] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (turns.length >= MAX_MESSAGES) break;
    const turn = parseClientTurn(items[index]!, index, budget);
    if (turn.length) turns.push(turn);
  }
  return turns.reverse().flat();
}

export function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return asRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

export function parseToolCalls(json: JsonMap): AssistantToolCall[] {
  const choices = Array.isArray(json.choices) ? json.choices : [];
  const message = asRecord(asRecord(choices[0])?.message);
  if (!message) return [];
  const out: AssistantToolCall[] = [];
  if (Array.isArray(message.tool_calls)) {
    for (const [index, item] of message.tool_calls.entries()) {
      const rec = asRecord(item);
      if (!rec) continue;
      const fn = asRecord(rec.function) ?? rec;
      const name = typeof fn.name === "string" ? fn.name.trim() : "";
      if (!name) continue;
      const args =
        typeof fn.arguments === "string"
          ? fn.arguments
          : JSON.stringify(fn.arguments ?? {});
      const id =
        typeof rec.id === "string" && rec.id.trim()
          ? rec.id
          : `call_${index}`;
      out.push({ id, name, arguments: args });
    }
  }
  const legacy = asRecord(message.function_call);
  if (legacy && typeof legacy.name === "string" && legacy.name.trim()) {
    out.push({
      id: "call_legacy",
      name: legacy.name.trim(),
      arguments:
        typeof legacy.arguments === "string" ? legacy.arguments : "{}",
    });
  }
  return out;
}

export function completionText(json: JsonMap): string {
  const choices = Array.isArray(json.choices) ? json.choices : [];
  const message = asRecord(asRecord(choices[0])?.message);
  if (!message) return "";
  return stringifyContent(message.content).trim();
}
