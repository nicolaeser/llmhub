import { consoleTimeZone } from "@/lib/hooks/use-console-time-zone";
import { logFilterParams, zonedLogFilters } from "@/lib/gateway/request-logs/request-log-query";
import type { LogFilterValues, LogKind, LogSessionRef } from "@/types/logs";

export function download(href: string) {
  const link = document.createElement("a");
  link.href = href;
  link.click();
}

export function queryFilters(filters: LogFilterValues): LogFilterValues {
  return zonedLogFilters(filters, consoleTimeZone());
}

export function exportHref(kind: LogKind, format: "csv" | "jsonl", filters: LogFilterValues) {
  const params = new URLSearchParams({ kind, format });
  for (const [key, value] of Object.entries(logFilterParams(queryFilters(filters)))) {
    if (value !== null) params.set(key, value);
  }
  return `/internal-api/logs/export?${params.toString()}`;
}

export function sessionHref(ref: LogSessionRef, tab: "chat" | "requests" = "chat") {
  const params = new URLSearchParams({ id: ref.sessionId, tab });
  if (ref.keyId) params.set("key", ref.keyId);
  if (ref.userId) params.set("user", ref.userId);
  return `/logs/session?${params.toString()}`;
}
