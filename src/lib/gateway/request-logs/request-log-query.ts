import { parseDate, parseDateTime } from "@internationalized/date";
import type { Prisma } from "@/generated/prisma/client";
import type { LogFilterValues } from "@/types/logs";
import type { SpendScope } from "@/types/structure";

const DAY_MS = 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/;
const UTC_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function parseLogFilters(input: unknown): LogFilterValues {
  const rec = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return {
    model: text(rec.model, 200),
    status: text(rec.status, 3),
    endpoint: text(rec.endpoint, 200),
    keyId: text(rec.keyId, 64),
    userId: text(rec.userId, 64),
    pii: rec.pii === true || rec.pii === "true" || rec.pii === "1",
    from: text(rec.from, 32),
    to: text(rec.to, 32),
  };
}

export function logFilterParams(filters: Partial<LogFilterValues>): Record<keyof LogFilterValues, string | null> {
  const value = (name: Exclude<keyof LogFilterValues, "pii">) => filters[name] || null;
  return {
    model: value("model"),
    status: value("status"),
    endpoint: value("endpoint"),
    keyId: value("keyId"),
    userId: value("userId"),
    pii: filters.pii ? "1" : null,
    from: value("from"),
    to: value("to"),
  };
}

export function logFiltersFromSearch(search: string): LogFilterValues {
  return parseLogFilters(Object.fromEntries(new URLSearchParams(search)));
}

export function logsHref(filters: Partial<LogFilterValues>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(logFilterParams(filters))) {
    if (value !== null) params.set(name, value);
  }
  const query = params.toString();
  return query ? `/logs?${query}` : "/logs";
}

function wallClockInstant(value: string, timeZone: string, bound: "start" | "end"): string {
  if (DATE_ONLY.test(value)) {
    const day = parseDate(value);
    if (bound === "start") return day.toDate(timeZone).toISOString();
    return new Date(day.add({ days: 1 }).toDate(timeZone).getTime() - 1).toISOString();
  }
  if (WALL_CLOCK.test(value)) return parseDateTime(value).toDate(timeZone).toISOString();
  return value;
}

function zonedBound(value: string, timeZone: string, bound: "start" | "end"): string {
  try {
    return wallClockInstant(value, timeZone, bound);
  } catch {
    return value;
  }
}

export function zonedLogFilters(filters: LogFilterValues, timeZone: string): LogFilterValues {
  return {
    ...filters,
    from: zonedBound(filters.from, timeZone, "start"),
    to: zonedBound(filters.to, timeZone, "end"),
  };
}

function rangeInstant(value: string): Date | null {
  if (!value) return null;
  const date = new Date(DATE_ONLY.test(value) || UTC_OFFSET.test(value) ? value : `${value}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function createdAtRange(from: string, to: string): Prisma.DateTimeFilter | undefined {
  const range: Prisma.DateTimeFilter = {};
  const start = rangeInstant(from);
  if (start) range.gte = start;
  const end = rangeInstant(to);
  if (end) {
    if (DATE_ONLY.test(to)) range.lt = new Date(end.getTime() + DAY_MS);
    else range.lte = end;
  }
  return Object.keys(range).length ? range : undefined;
}

function scoped(filters: LogFilterValues, scope: SpendScope) {
  const requested = {
    ...(filters.userId ? { userId: filters.userId } : {}),
    ...(filters.keyId ? { keyId: filters.keyId } : {}),
    ...(filters.model ? { model: filters.model } : {}),
  };
  return { AND: [requested, scope] };
}

export function requestLogWhere(filters: LogFilterValues, scope: SpendScope): Prisma.RequestLogWhereInput {
  const status = filters.status ? Number(filters.status) : Number.NaN;
  const createdAt = createdAtRange(filters.from, filters.to);
  return {
    ...scoped(filters, scope),
    ...(Number.isInteger(status) ? { status } : {}),
    ...(filters.endpoint ? { endpoint: { contains: filters.endpoint } } : {}),
    ...(filters.pii ? { OR: [{ piiInput: { isEmpty: false } }, { piiOutput: { isEmpty: false } }] } : {}),
    ...(createdAt ? { createdAt } : {}),
  };
}

export function spendEventWhere(filters: LogFilterValues, scope: SpendScope): Prisma.SpendEventWhereInput {
  const createdAt = createdAtRange(filters.from, filters.to);
  return {
    ...scoped(filters, scope),
    ...(createdAt ? { createdAt } : {}),
  };
}

export function auditLogWhere(filters: LogFilterValues): Prisma.GatewayAuditLogWhereInput {
  const createdAt = createdAtRange(filters.from, filters.to);
  return createdAt ? { createdAt } : {};
}
