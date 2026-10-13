import type { Prisma } from "@/generated/prisma/client";
import type { LogFilterValues } from "@/types/logs";
import type { SpendScope } from "@/types/structure";

const DAY_MS = 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

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

export function createdAtRange(from: string, to: string): Prisma.DateTimeFilter | undefined {
  const range: Prisma.DateTimeFilter = {};
  const start = from ? new Date(from) : null;
  if (start && !Number.isNaN(start.getTime())) range.gte = start;
  const end = to ? new Date(to) : null;
  if (end && !Number.isNaN(end.getTime())) {
    if (DATE_ONLY.test(to)) range.lt = new Date(end.getTime() + DAY_MS);
    else range.lte = end;
  }
  return Object.keys(range).length ? range : undefined;
}

function scoped(filters: LogFilterValues, scope: SpendScope) {
  return {
    ...(filters.userId ? { userId: filters.userId } : {}),
    ...(filters.keyId ? { keyId: filters.keyId } : {}),
    ...(filters.model ? { model: filters.model } : {}),
    ...scope,
  };
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
