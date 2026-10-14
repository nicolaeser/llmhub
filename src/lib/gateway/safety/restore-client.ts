import { restoreJson, restoreSseResponse, vaultOf } from "@/lib/gateway/safety/pii-vault";
import type { RequestTrace } from "@/types/gateway";

export function restoreClientJson<T>(trace: RequestTrace | undefined, value: T): T {
  return restoreJson(structuredClone(value), vaultOf(trace)) as T;
}

export function restoreClientStream(trace: RequestTrace | undefined, response: Response): Response {
  return restoreSseResponse(response, vaultOf(trace));
}
