import { gatewayPath } from "@/lib/gateway/api-paths";
import { asRecord, stringifyContent } from "@/lib/gateway/core";
import { vaultOf } from "@/lib/gateway/safety/pii-vault";
import type { JsonMap, RequestTrace } from "@/types/gateway";

export const PII_RESTORE_INSTRUCTION = [
  "Privacy note from the gateway: this gateway is a privacy proxy between you and the user.",
  "Before the conversation reached you, it replaced personal data with numbered placeholders of the form [TYPE_N].",
  "It puts the real values back into everything you write before the user or any tool sees it: text, code, commands, file contents, and tool call arguments.",
  "So treat each placeholder exactly as the real value and work normally: run the commands, write the code, and pass the placeholder to tools where the value belongs.",
  "Never say that you cannot see a value, never ask the user for it, and never tell the user to run something themselves because of a placeholder.",
  "The same placeholder always means the same value. Write placeholders exactly as given, and never invent new ones or change their numbers.",
  "Placeholders without a number, such as [SECRET], are removed credentials that are not put back; for those you may say that a credential was removed.",
].join(" ");

const PLAYGROUND_CHAT_PATH = "/internal-api/playground/chat";

const BATCH_ENDPOINT_PREFIX = "batch:";
const CONVERSATION_ENDPOINTS = new Set(["/v1/chat/completions", "/v1/responses", "/v1/messages", PLAYGROUND_CHAT_PATH]);
const INSTRUCTION_ROLES = new Set(["system", "developer"]);

export function isConversationEndpoint(endpoint: string): boolean {
  const path = endpoint.startsWith(BATCH_ENDPOINT_PREFIX) ? endpoint.slice(BATCH_ENDPOINT_PREFIX.length) : endpoint;
  return CONVERSATION_ENDPOINTS.has(gatewayPath(path));
}

export function needsPiiInstruction(trace: RequestTrace | undefined): boolean {
  if (!trace || trace.piiMode !== "restore" || !isConversationEndpoint(trace.endpoint)) return false;
  return (vaultOf(trace)?.size ?? 0) > 0;
}

function mentionsInstruction(content: unknown): boolean {
  return stringifyContent(content).includes(PII_RESTORE_INSTRUCTION);
}

function appendedText(text: string): string {
  return text ? `${text}\n\n${PII_RESTORE_INSTRUCTION}` : PII_RESTORE_INSTRUCTION;
}

function appendedContent(content: unknown): unknown {
  if (typeof content === "string") return appendedText(content);
  if (!Array.isArray(content)) return null;
  const separator = stringifyContent(content) ? "\n\n" : "";
  return [...content, { type: "text", text: `${separator}${PII_RESTORE_INSTRUCTION}` }];
}

function isInstructionMessage(message: unknown): boolean {
  return INSTRUCTION_ROLES.has(String(asRecord(message)?.role ?? ""));
}

export function withChatPiiInstruction(body: JsonMap): JsonMap {
  if (!Array.isArray(body.messages)) return body;
  const messages: unknown[] = body.messages;
  if (messages.some((message) => isInstructionMessage(message) && mentionsInstruction(asRecord(message)?.content))) {
    return body;
  }
  const leading = asRecord(messages[0]);
  const content = leading && isInstructionMessage(leading) ? appendedContent(leading.content) : null;
  if (leading && content !== null) return { ...body, messages: [{ ...leading, content }, ...messages.slice(1)] };
  return { ...body, messages: [{ role: "system", content: PII_RESTORE_INSTRUCTION }, ...messages] };
}

export function withMessagesPiiInstruction(body: JsonMap): JsonMap {
  const system = body.system;
  if (mentionsInstruction(system)) return body;
  if (typeof system === "string") return { ...body, system: appendedText(system) };
  if (Array.isArray(system)) return { ...body, system: [...system, { type: "text", text: PII_RESTORE_INSTRUCTION }] };
  return { ...body, system: PII_RESTORE_INSTRUCTION };
}

export function instructChat(trace: RequestTrace | undefined, body: JsonMap): JsonMap {
  return needsPiiInstruction(trace) ? withChatPiiInstruction(body) : body;
}

export function instructMessages(trace: RequestTrace | undefined, body: JsonMap): JsonMap {
  return needsPiiInstruction(trace) ? withMessagesPiiInstruction(body) : body;
}
