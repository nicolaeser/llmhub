import { joinKey } from "@/lib/s3/url";
import type {
  ArchiveDataset,
  ArchiveHoldRun,
  ArchiveObjectLock,
  ComplianceArchiveSettings,
  RetentionHolds,
} from "@/types/archive";
import type { RetentionTable } from "@/types/jobs";

export const DAY_MS = 86_400_000;
export const ARCHIVE_GRACE_MS = 15 * 60_000;
export const ARCHIVE_EXPIRY_MARGIN_MS = 60 * 60_000;
export const ARCHIVE_MAX_PLANNED_DAYS = 3_660;
export const ARCHIVE_ALERT_AFTER_ATTEMPTS = 3;

const RETRY_DELAYS_MS = [5, 15, 60, 180, 360, 720, 1_440].map((minutes) => minutes * 60_000);

const OPEN_STATUSES = new Set(["pending", "running", "failed"]);
const DONE_STATUSES = new Set(["done", "expired"]);

export function utcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

export function addDays(day: Date, days: number): Date {
  return new Date(day.getTime() + days * DAY_MS);
}

export function dayKey(day: Date): string {
  return day.toISOString().slice(0, 10);
}

export function lastClosedDay(now: Date, graceMs = ARCHIVE_GRACE_MS): Date {
  return addDays(utcDay(new Date(now.getTime() - graceMs)), -1);
}

export function planDays(first: Date, last: Date, limit = ARCHIVE_MAX_PLANNED_DAYS): Date[] {
  const days: Date[] = [];
  for (let day = utcDay(first); day.getTime() <= last.getTime() && days.length < limit; day = addDays(day, 1)) days.push(day);
  return days;
}

export function retryDelayMs(attempts: number): number {
  const index = Math.min(RETRY_DELAYS_MS.length - 1, Math.max(0, Math.trunc(attempts) - 1));
  return RETRY_DELAYS_MS[index];
}

export function archiveBaseKey(prefix: string, dataset: ArchiveDataset, day: Date): string {
  const key = dayKey(day);
  return joinKey(prefix, dataset, key.slice(0, 4), key.slice(5, 7), `${dataset}-${key}`);
}

export function archiveRetainUntil(day: Date, retentionDays: number): Date | null {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return null;
  return addDays(utcDay(day), 1 + Math.trunc(retentionDays));
}

export function archiveObjectLock(settings: Pick<ComplianceArchiveSettings, "lock_mode" | "retention_days">, day: Date): ArchiveObjectLock | null {
  const retainUntil = archiveRetainUntil(day, settings.retention_days);
  if (settings.lock_mode === "none" || !retainUntil) return null;
  return { mode: settings.lock_mode, retainUntil };
}

export function objectLockHeaders(lock: ArchiveObjectLock | null): Record<string, string> {
  if (!lock) return {};
  return {
    "x-amz-object-lock-mode": lock.mode.toUpperCase(),
    "x-amz-object-lock-retain-until-date": lock.retainUntil.toISOString(),
  };
}

export function lastExpiredDay(now: Date, retentionDays: number): Date | null {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return null;
  return utcDay(new Date(now.getTime() - ARCHIVE_EXPIRY_MARGIN_MS - (1 + Math.trunc(retentionDays)) * DAY_MS));
}

export function datasetTables(dataset: ArchiveDataset, includeContent: boolean): RetentionTable[] {
  switch (dataset) {
    case "requests":
      return includeContent ? ["requestLogs", "requestContents"] : ["requestLogs"];
    case "audit":
      return ["auditLogs"];
    case "security":
      return ["securityEvents"];
    case "tools":
      return ["toolExecutions"];
  }
}

export function archivedBefore(runs: readonly ArchiveHoldRun[]): Date {
  let firstOpen: Date | null = null;
  let lastDone: Date | null = null;
  for (const run of runs) {
    if (OPEN_STATUSES.has(run.status) && (!firstOpen || run.day < firstOpen)) firstOpen = run.day;
    if (DONE_STATUSES.has(run.status) && (!lastDone || run.day > lastDone)) lastDone = run.day;
  }
  if (firstOpen) return utcDay(firstOpen);
  if (lastDone) return addDays(utcDay(lastDone), 1);
  return new Date(0);
}

export function retentionHolds(
  settings: Pick<ComplianceArchiveSettings, "enabled" | "datasets" | "include_content">,
  holdsByDataset: Partial<Record<ArchiveDataset, Date>>,
): RetentionHolds {
  if (!settings.enabled) return {};
  const holds: RetentionHolds = {};
  for (const dataset of settings.datasets) {
    const hold = holdsByDataset[dataset] ?? new Date(0);
    for (const table of datasetTables(dataset, settings.include_content)) {
      const current = holds[table];
      holds[table] = current && current < hold ? current : hold;
    }
  }
  return holds;
}

export function holdArchivedTables(
  settings: Pick<ComplianceArchiveSettings, "enabled" | "datasets" | "include_content">,
): RetentionHolds {
  return retentionHolds(settings, {});
}

export function heldCutoff(cutoff: Date | null, hold: Date | undefined): Date | null {
  if (!cutoff || !hold) return cutoff;
  return hold < cutoff ? hold : cutoff;
}
