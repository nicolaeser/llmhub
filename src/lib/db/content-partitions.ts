import "server-only";
import prisma from "@/lib/db/prisma";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import type { ContentPartition, ContentPartitionPolicy, ContentStorage } from "@/types/logs";

export const CONTENT_PARTITIONS_AHEAD = 7;
export const CONTENT_DDL_LOCK_TIMEOUT = "3s";

const DAY_MS = 86_400_000;
const GIB = 1024 ** 3;
const PARENT = "RequestLogContent";
const DROPPABLE = /^RequestLogContent_(?:p\d{8}|legacy)$/;
const UPPER_BOUND = /TO \('(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)?'\)/;
const LOWER_BOUND = /FROM \('(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)?'\)/;

type PartitionRow = { name: string; bound: string | null; bytes: number };
type SizeRow = { database: number; logs: number };

export function utcDayStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

export function contentPartitionName(day: Date): string {
  const stamp = utcDayStart(day).toISOString().slice(0, 10).replaceAll("-", "");
  return `${PARENT}_p${stamp}`;
}

function boundTime(bound: string, pattern: RegExp): Date | null {
  const match = pattern.exec(bound);
  return match ? new Date(`${match[1]}T${match[2]}Z`) : null;
}

function boundLiteral(day: Date): string {
  return `${day.toISOString().slice(0, 10)} 00:00:00`;
}

export function contentPartitionOf(row: PartitionRow): ContentPartition {
  const bound = row.bound ?? "";
  return {
    name: row.name,
    from: boundTime(bound, LOWER_BOUND),
    to: boundTime(bound, UPPER_BOUND),
    bytes: Number(row.bytes) || 0,
  };
}

export async function listContentPartitions(): Promise<ContentPartition[]> {
  const rows = await prisma.$queryRaw<PartitionRow[]>`
    SELECT c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bound, pg_total_relation_size(c.oid)::float8 AS bytes
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = to_regclass('"RequestLogContent"')
    ORDER BY c.relname`;
  return rows.map(contentPartitionOf);
}

export async function defaultPartitionDays(): Promise<Date[]> {
  try {
    const rows = await prisma.$queryRaw<{ day: string }[]>`
      SELECT DISTINCT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS day FROM "RequestLogContent_default"`;
    return rows.map((row) => new Date(`${row.day}T00:00:00Z`));
  } catch (err) {
    logger.warn("retention.content_default_unreadable", errorFields(err));
    return [];
  }
}

export function missingContentDays(
  partitions: ContentPartition[],
  now: Date,
  ahead = CONTENT_PARTITIONS_AHEAD,
  heldByDefault: Date[] = [],
): Date[] {
  const today = utcDayStart(now).getTime();
  const ranged = partitions.filter((partition) => partition.to !== null);
  const held = new Set(heldByDefault.map((day) => utcDayStart(day).getTime()));
  const days: Date[] = [];
  for (let offset = 0; offset <= ahead; offset += 1) {
    const day = today + offset * DAY_MS;
    if (held.has(day)) continue;
    const covered = ranged.some(
      (partition) => (partition.from === null || partition.from.getTime() <= day) && day < partition.to!.getTime(),
    );
    if (!covered) days.push(new Date(day));
  }
  return days;
}

export function expiredContentPartitions(partitions: ContentPartition[], policy: ContentPartitionPolicy): ContentPartition[] {
  const today = utcDayStart(policy.now).getTime();
  const ranged = partitions
    .filter((partition) => partition.to !== null && DROPPABLE.test(partition.name))
    .sort((a, b) => a.to!.getTime() - b.to!.getTime());
  const expired = ranged.filter((partition) => policy.cutoff !== null && partition.to!.getTime() <= policy.cutoff.getTime());
  if (policy.maxBytes <= 0) return expired;
  let total = partitions.reduce((sum, partition) => sum + partition.bytes, 0) - expired.reduce((sum, partition) => sum + partition.bytes, 0);
  for (const partition of ranged) {
    if (expired.includes(partition)) continue;
    if (total <= policy.maxBytes || partition.to!.getTime() > today) break;
    expired.push(partition);
    total -= partition.bytes;
  }
  return expired;
}

async function runDdl(statement: string): Promise<void> {
  await prisma.$transaction([
    prisma.$executeRawUnsafe(`SET LOCAL lock_timeout = '${CONTENT_DDL_LOCK_TIMEOUT}'`),
    prisma.$executeRawUnsafe(`LOCK TABLE "RequestLog" IN SHARE ROW EXCLUSIVE MODE`),
    prisma.$executeRawUnsafe(statement),
  ]);
}

export async function createContentPartition(day: Date): Promise<boolean> {
  const from = utcDayStart(day);
  const name = contentPartitionName(from);
  try {
    await runDdl(
      `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF "${PARENT}" FOR VALUES FROM ('${boundLiteral(from)}') TO ('${boundLiteral(new Date(from.getTime() + DAY_MS))}')`,
    );
    return true;
  } catch (err) {
    logger.warn("retention.content_partition_not_created", { partition: name, ...errorFields(err) });
    return false;
  }
}

export async function dropContentPartition(partition: ContentPartition): Promise<boolean> {
  if (!DROPPABLE.test(partition.name)) return false;
  try {
    await runDdl(`DROP TABLE IF EXISTS "${partition.name}"`);
    logger.info("retention.content_partition_dropped", { partition: partition.name, bytes: partition.bytes });
    return true;
  } catch (err) {
    logger.warn("retention.content_partition_not_dropped", { partition: partition.name, ...errorFields(err) });
    return false;
  }
}

export async function maintainContentPartitions(policy: ContentPartitionPolicy): Promise<number> {
  const partitions = await listContentPartitions();
  if (!partitions.length) return 0;
  const missing = missingContentDays(partitions, policy.now);
  if (missing.length) {
    const held = await defaultPartitionDays();
    for (const day of missingContentDays(partitions, policy.now, CONTENT_PARTITIONS_AHEAD, held)) await createContentPartition(day);
  }
  let dropped = 0;
  for (const partition of expiredContentPartitions(partitions, policy)) {
    if (await dropContentPartition(partition)) dropped += 1;
  }
  return dropped;
}

export function contentMaxBytes(gigabytes: number | undefined): number {
  return Number.isFinite(gigabytes) && gigabytes! > 0 ? Math.round(gigabytes! * GIB) : 0;
}

export async function contentStorage(): Promise<ContentStorage> {
  const partitions = await listContentPartitions();
  const sizes = await prisma.$queryRaw<SizeRow[]>`
    SELECT pg_database_size(current_database())::float8 AS database,
           pg_total_relation_size(to_regclass('"RequestLog"'))::float8 AS logs`;
  return {
    databaseBytes: Number(sizes[0]?.database) || 0,
    logBytes: Number(sizes[0]?.logs) || 0,
    contentBytes: partitions.reduce((sum, partition) => sum + partition.bytes, 0),
  };
}
