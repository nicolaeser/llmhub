import { restoreJson, restoreSseResponse, vaultOf } from "@/lib/gateway/safety/pii-vault";
import { restoreMessagesSse } from "@/lib/gateway/safety/restore-messages";
import type { RequestTrace } from "@/types/gateway";

export function restoreClientJson<T>(trace: RequestTrace | undefined, value: T): T {
  const vault = vaultOf(trace);
  return vault?.size ? (restoreJson(value, vault) as T) : value;
}

export function restoreClientStream(trace: RequestTrace | undefined, response: Response): Response {
  return restoreSseResponse(response, vaultOf(trace));
}

export function restoreClientMessagesStream(trace: RequestTrace | undefined, response: Response): Response {
  return restoreMessagesSse(response, vaultOf(trace));
}
