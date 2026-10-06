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

export function parseClientMessages(raw: unknown): AssistantMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: AssistantMessage[] = [];
  for (const item of raw) {
    const rec = asRecord(item);
    if (!rec) continue;
    if (rec.role !== "user" && rec.role !== "assistant") continue;
    const content = stringifyContent(rec.content).trim().slice(0, MAX_CONTENT);
    if (!content) continue;
    out.push({ role: rec.role, content });
  }
  return out.slice(-MAX_MESSAGES);
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
