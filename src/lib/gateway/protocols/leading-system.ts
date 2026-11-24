import { asRecord, stringifyContent } from "@/lib/gateway/core";
import type { JsonMap } from "@/types/gateway";

function isInstructionMessage(message: unknown): boolean {
  const role = asRecord(message)?.role;
  return role === "system" || role === "developer";
}

function isPlainSystemMessage(message: unknown): boolean {
  const record = asRecord(message);
  return record?.role === "system" && typeof record.content === "string" && record.content !== "";
}

export function withSingleLeadingSystem(body: JsonMap): JsonMap {
  if (!Array.isArray(body.messages)) return body;
  const messages: unknown[] = body.messages;
  const instructionCount = messages.filter(isInstructionMessage).length;
  if (instructionCount === 0 || (instructionCount === 1 && isPlainSystemMessage(messages[0]))) return body;
  const system = messages
    .filter(isInstructionMessage)
    .map((message) => stringifyContent(asRecord(message)?.content))
    .filter(Boolean)
    .join("\n\n");
  const rest = messages.filter((message) => !isInstructionMessage(message));
  return { ...body, messages: system ? [{ role: "system", content: system }, ...rest] : rest };
}

function mentionsInstruction(content: unknown, instruction: string): boolean {
  return stringifyContent(content).includes(instruction);
}

function appendedText(text: string, instruction: string): string {
  return text ? `${text}\n\n${instruction}` : instruction;
}

function appendedContent(content: unknown, instruction: string): unknown {
  if (typeof content === "string") return appendedText(content, instruction);
  if (!Array.isArray(content)) return null;
  const separator = stringifyContent(content) ? "\n\n" : "";
  return [...content, { type: "text", text: `${separator}${instruction}` }];
}

export function withChatInstruction(body: JsonMap, instruction: string): JsonMap {
  if (!Array.isArray(body.messages)) return body;
  const messages: unknown[] = body.messages;
  if (messages.some((message) => isInstructionMessage(message) && mentionsInstruction(asRecord(message)?.content, instruction))) {
    return body;
  }
  const leading = asRecord(messages[0]);
  const content = leading && isInstructionMessage(leading) ? appendedContent(leading.content, instruction) : null;
  if (leading && content !== null) return { ...body, messages: [{ ...leading, content }, ...messages.slice(1)] };
  return { ...body, messages: [{ role: "system", content: instruction }, ...messages] };
}

export function withMessagesInstruction(body: JsonMap, instruction: string): JsonMap {
  const system = body.system;
  if (mentionsInstruction(system, instruction)) return body;
  if (typeof system === "string") return { ...body, system: appendedText(system, instruction) };
  if (Array.isArray(system)) return { ...body, system: [...system, { type: "text", text: instruction }] };
  return { ...body, system: instruction };
}
