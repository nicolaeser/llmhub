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
