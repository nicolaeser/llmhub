import type { RequestStatusTone } from "@/types/logs";

export function requestStatusTone(status: number): RequestStatusTone {
  return status >= 500 ? "danger" : status >= 400 ? "warning" : "success";
}
