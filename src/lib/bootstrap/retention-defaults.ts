import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import prisma from "@/lib/db/prisma";
import {
  DEFAULT_OBJECT_RETENTION_DAYS,
  DEFAULT_SECURITY_RETENTION_DAYS,
} from "@/lib/settings/retention-defaults";

export const RETENTION_DEFAULTS_ADOPTED = "retention_defaults_7d_5gb";

const SETTING_ENTERPRISE = "enterprise";

const REPLACED_DEFAULTS: Record<string, number> = {
  log_retention_days: 30,
  content_retention_days: 30,
  content_max_gb: 0,
};

const UNCHANGED_DEFAULTS: Record<string, number> = {
  spend_retention_days: 0,
  usage_retention_days: 0,
  audit_retention_days: 0,
  security_retention_days: DEFAULT_SECURITY_RETENTION_DAYS,
  object_retention_days: DEFAULT_OBJECT_RETENTION_DAYS,
  file_retention_days: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function storedNumber(record: Record<string, unknown>, field: string, fallback: number): number {
  const value = record[field];
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function withAdoptedRetentionDefaults(stored: unknown): Record<string, unknown> | null {
  if (!isRecord(stored)) return null;
  const tuned = Object.entries(UNCHANGED_DEFAULTS).some(
    ([field, fallback]) => storedNumber(stored, field, fallback) !== fallback,
  );
  if (tuned) return null;
  const stale = Object.entries(REPLACED_DEFAULTS)
    .filter(([field, previous]) => field in stored && storedNumber(stored, field, previous) === previous)
    .map(([field]) => field);
  if (!stale.length) return null;
  return Object.fromEntries(Object.entries(stored).filter(([field]) => !stale.includes(field)));
}

function parsed(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

async function markAdopted(db: Prisma.TransactionClient): Promise<void> {
  await db.setting.upsert({
    where: { key: RETENTION_DEFAULTS_ADOPTED },
    update: {},
    create: { key: RETENTION_DEFAULTS_ADOPTED, value: "1" },
  });
}

export async function adoptRetentionDefaults(db: Prisma.TransactionClient = prisma): Promise<void> {
  if (await db.setting.findUnique({ where: { key: RETENTION_DEFAULTS_ADOPTED } })) return;
  const loggingSaved = await db.gatewayAuditLog.findFirst({
    where: { action: "settings.logging" },
    select: { id: true },
  });
  const row = await db.setting.findUnique({ where: { key: SETTING_ENTERPRISE } });
  const next = loggingSaved || !row ? null : withAdoptedRetentionDefaults(parsed(row.value));
  if (row && next) {
    const { count } = await db.setting.updateMany({
      where: { key: SETTING_ENTERPRISE, value: row.value },
      data: { value: JSON.stringify(next) },
    });
    if (!count) return;
  }
  await markAdopted(db);
}
