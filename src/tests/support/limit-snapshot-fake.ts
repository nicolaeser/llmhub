import { Prisma } from "@/generated/prisma/client";

type Row = Record<string, unknown> & { providerId: string };
type Where = Record<string, unknown>;
type Related = (providerId: string) => Record<string, unknown> | null;

export const snapshotRows = new Map<string, Row>();

function defaults(providerId: string): Row {
  return {
    providerId,
    limits: null,
    resets: null,
    resetsAt: null,
    error: "",
    fetchedAt: null,
    checkedAt: null,
    nextAt: new Date(),
    retryAt: null,
    failures: 0,
    loginVersion: -1,
    leaseUntil: null,
    leaseToken: "",
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export function seedSnapshot(providerId: string, fields: Record<string, unknown> = {}): void {
  snapshotRows.set(providerId, { ...defaults(providerId), ...fields });
}

function plain(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value;
}

function compare(actual: unknown, operator: string, expected: unknown): boolean {
  const a = plain(actual);
  const b = plain(expected);
  if (a === null || a === undefined) return false;
  if (operator === "lt") return (a as number) < (b as number);
  if (operator === "lte") return (a as number) <= (b as number);
  if (operator === "gt") return (a as number) > (b as number);
  if (operator === "gte") return (a as number) >= (b as number);
  return false;
}

function matchField(actual: unknown, condition: unknown): boolean {
  if (condition === null) return actual === null || actual === undefined;
  if (condition instanceof Date || typeof condition !== "object") return plain(actual) === plain(condition);
  const rules = condition as Record<string, unknown>;
  return Object.entries(rules).every(([operator, expected]) => {
    if (operator === "in") return (expected as unknown[]).includes(actual);
    if (operator === "not") return expected === null ? actual !== null && actual !== undefined : plain(actual) !== plain(expected);
    return compare(actual, operator, expected);
  });
}

export function matchesWhere(row: Row, where: Where = {}, related: Related = () => null): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "AND") return (condition as Where[]).every((part) => matchesWhere(row, part, related));
    if (key === "OR") return (condition as Where[]).some((part) => matchesWhere(row, part, related));
    if (key === "provider") return related(row.providerId) !== null;
    return matchField(row[key], condition);
  });
}

function applyData(row: Row, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === "object" && !(value instanceof Date) && "increment" in value) {
      row[key] = (row[key] as number) + (value as { increment: number }).increment;
    } else {
      row[key] = value === Prisma.DbNull ? null : value;
    }
  }
  row.updatedAt = new Date();
}

function pick(row: Row, select: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).map((key) => [key, row[key]]));
}

export function limitSnapshotModel(related: Related = () => ({})) {
  return {
    createMany: async ({ data, skipDuplicates }: { data: Row[]; skipDuplicates?: boolean }) => {
      let count = 0;
      for (const item of data) {
        if (snapshotRows.has(item.providerId)) {
          if (!skipDuplicates) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
          continue;
        }
        if (related(item.providerId) === null) {
          throw Object.assign(new Error("Foreign key constraint failed"), { code: "P2003" });
        }
        snapshotRows.set(item.providerId, { ...defaults(item.providerId), ...item });
        count += 1;
      }
      return { count };
    },
    findUnique: async ({ where }: { where: { providerId: string } }) => {
      const row = snapshotRows.get(where.providerId);
      return row ? { ...row } : null;
    },
    findMany: async ({
      where,
      select,
      include,
    }: {
      where?: Where;
      select?: Record<string, unknown>;
      include?: { provider?: unknown };
    }) =>
      [...snapshotRows.values()]
        .filter((row) => matchesWhere(row, where, related))
        .map((row) => ({ ...pick(row, select), ...(include?.provider ? { provider: related(row.providerId) } : {}) })),
    updateMany: async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
      let count = 0;
      for (const row of snapshotRows.values()) {
        if (!matchesWhere(row, where, related)) continue;
        applyData(row, data);
        count += 1;
      }
      return { count };
    },
  };
}
