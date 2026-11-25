import { logFilterParams } from "@/lib/gateway/request-logs/request-log-query";
import type {
  KeyBudgetUsage,
  LiveKeyUsage,
  LiveLogRows,
  LiveRunning,
  LogFilterValues,
  RequestActivity,
  RequestLogRow,
  RunningRequest,
} from "@/types/logs";
import type { SpendScope } from "@/types/structure";

export const LOG_LIVE_URL = "/internal-api/logs/live";
export const LOG_LIVE_BACKFILL_MS = 10 * 60_000;

type ActivityDims = Omit<RequestActivity, "kind">;

export function liveSince(value: string | null | undefined, now: number): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return now;
  return Math.min(now, Math.max(now - LOG_LIVE_BACKFILL_MS, parsed));
}

export function logLiveUrl(filters: LogFilterValues, since: string | null): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(logFilterParams(filters))) {
    if (value !== null) params.set(name, value);
  }
  if (since) params.set("since", since);
  const query = params.toString();
  return query ? `${LOG_LIVE_URL}?${query}` : LOG_LIVE_URL;
}

export function activityMatches(filters: LogFilterValues, scope: SpendScope, dims: ActivityDims): boolean {
  if (scope.orgId && dims.orgId !== scope.orgId) return false;
  if (scope.userId && dims.userId !== scope.userId) return false;
  if (filters.keyId && dims.keyId !== filters.keyId) return false;
  if (filters.userId && dims.userId !== filters.userId) return false;
  return !filters.session || dims.sessionId === filters.session;
}

export function runningMatches(
  filters: LogFilterValues,
  scope: SpendScope,
  entry: ActivityDims & Pick<RunningRequest, "model" | "endpoint">,
): boolean {
  if (filters.status || filters.pii || filters.label || filters.to) return false;
  if (filters.model && entry.model !== filters.model) return false;
  if (filters.endpoint && !entry.endpoint.includes(filters.endpoint)) return false;
  return activityMatches(filters, scope, entry);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isRow(value: unknown): value is RequestLogRow {
  const row = record(value);
  return Boolean(row && typeof row.id === "string" && row.id && typeof row.createdAt === "string");
}

export function liveRowsOf(data: unknown): LiveLogRows | null {
  const event = record(data);
  if (!event || !Array.isArray(event.rows)) return null;
  return { rows: event.rows.filter(isRow), more: event.more === true };
}

function runningOf(value: unknown): RunningRequest | null {
  const item = record(value);
  const id = text(item?.id);
  const startedAt = text(item?.startedAt);
  if (!item || !id || !startedAt || !Number.isFinite(Date.parse(startedAt))) return null;
  return {
    id,
    startedAt,
    model: text(item.model) ?? "",
    endpoint: text(item.endpoint) ?? "",
    stream: item.stream === true,
    keyId: text(item.keyId) ?? "",
    agent: text(item.agent) ?? "",
  };
}

export function liveRunningOf(data: unknown): LiveRunning | null {
  const event = record(data);
  const at = finite(event?.at);
  if (!event || at === null || !Array.isArray(event.items)) return null;
  return { at, items: event.items.flatMap((item) => runningOf(item) ?? []) };
}

export function keyBudgetUsageOf(value: unknown): KeyBudgetUsage | null {
  const usage = record(value);
  const keyId = text(usage?.keyId);
  const spend = finite(usage?.spend);
  const maxBudget = finite(usage?.maxBudget);
  const boost = finite(usage?.boost);
  if (!usage || !keyId || spend === null || maxBudget === null || boost === null) return null;
  return {
    keyId,
    label: text(usage.label) ?? "",
    spend,
    maxBudget,
    boost,
    budgetDuration: text(usage.budgetDuration) ?? "",
    resetsAt: text(usage.resetsAt),
  };
}

export function liveKeyUsageOf(data: unknown): LiveKeyUsage | null {
  const event = record(data);
  const at = finite(event?.at);
  if (!event || at === null) return null;
  return { at, usage: keyBudgetUsageOf(event.usage) };
}

function newestFirst(a: RequestLogRow, b: RequestLogRow): number {
  return Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id);
}

export function mergeLiveRows(
  current: RequestLogRow[],
  incoming: RequestLogRow[],
  limit: number,
): { rows: RequestLogRow[]; added: number } {
  const known = new Set(current.map((row) => row.id));
  const fresh = incoming.filter((row, index) => !known.has(row.id) && incoming.findIndex((item) => item.id === row.id) === index);
  if (!fresh.length) return { rows: current, added: 0 };
  return { rows: [...fresh, ...current].sort(newestFirst).slice(0, limit), added: fresh.length };
}

export function usageRatio(usage: Pick<KeyBudgetUsage, "spend" | "maxBudget" | "boost">): number | null {
  const cap = usage.maxBudget > 0 ? usage.maxBudget + usage.boost : 0;
  return cap > 0 ? usage.spend / cap : null;
}
