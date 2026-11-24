import { gatewayPath } from "@/lib/gateway/api-paths";
import { withChatInstruction, withMessagesInstruction } from "@/lib/gateway/protocols/leading-system";
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

export function isConversationEndpoint(endpoint: string): boolean {
  const path = endpoint.startsWith(BATCH_ENDPOINT_PREFIX) ? endpoint.slice(BATCH_ENDPOINT_PREFIX.length) : endpoint;
  return CONVERSATION_ENDPOINTS.has(gatewayPath(path));
}

export function needsPiiInstruction(trace: RequestTrace | undefined): boolean {
  if (!trace || trace.piiMode !== "restore" || !isConversationEndpoint(trace.endpoint)) return false;
  return (vaultOf(trace)?.size ?? 0) > 0;
}

export function withChatPiiInstruction(body: JsonMap): JsonMap {
  return withChatInstruction(body, PII_RESTORE_INSTRUCTION);
}

export function withMessagesPiiInstruction(body: JsonMap): JsonMap {
  return withMessagesInstruction(body, PII_RESTORE_INSTRUCTION);
}

export function instructChat(trace: RequestTrace | undefined, body: JsonMap): JsonMap {
  return needsPiiInstruction(trace) ? withChatPiiInstruction(body) : body;
}

export function instructMessages(trace: RequestTrace | undefined, body: JsonMap): JsonMap {
  return needsPiiInstruction(trace) ? withMessagesPiiInstruction(body) : body;
}
