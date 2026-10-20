import { restoreJson, vaultOf } from "@/lib/gateway/safety/pii-vault";
import { restoreChatSse } from "@/lib/gateway/safety/restore-chat";
import { restoreMessagesSse } from "@/lib/gateway/safety/restore-messages";
import { restoreResponsesSse } from "@/lib/gateway/safety/restore-responses";
import type { RequestTrace } from "@/types/gateway";

export function restoreClientJson<T>(trace: RequestTrace | undefined, value: T): T {
  const vault = vaultOf(trace);
  return vault?.size ? (restoreJson(value, vault) as T) : value;
}

export function restoreClientChatStream(trace: RequestTrace | undefined, response: Response): Response {
  return restoreChatSse(response, vaultOf(trace));
}

export function restoreClientResponsesStream(trace: RequestTrace | undefined, response: Response): Response {
  return restoreResponsesSse(response, vaultOf(trace));
}

export function restoreClientMessagesStream(trace: RequestTrace | undefined, response: Response): Response {
  return restoreMessagesSse(response, vaultOf(trace));
}
