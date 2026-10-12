import type { ReportCadence, ReportPeriod } from "@/types/reports";

export const REPORT_CADENCES = ["weekly", "monthly"] as const;

export const REPORT_FORMATS = ["pdf", "csv", "both"] as const;

export const MAX_REPORT_RECIPIENTS = 20;

export const REPORT_GRACE_MS = 3_600_000;

const DAY_MS = 86_400_000;

export function reportCadence(value: string): ReportCadence {
  return value === "weekly" ? "weekly" : "monthly";
}

function periodFrom(cadence: ReportCadence, start: number): ReportPeriod {
  const first = new Date(start);
  const end =
    cadence === "weekly" ? start + 7 * DAY_MS : Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1);
  return {
    cadence,
    key: `${cadence}:${first.toISOString().slice(0, 10)}`,
    start: first,
    end: new Date(end),
    days: Math.round((end - start) / DAY_MS),
  };
}

function currentStart(cadence: ReportCadence, at: Date): number {
  if (cadence === "monthly") return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
  const day = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  return day - ((at.getUTCDay() + 6) % 7) * DAY_MS;
}

export function lastCompletedPeriod(cadence: ReportCadence, now = new Date()): ReportPeriod {
  const current = new Date(currentStart(cadence, new Date(now.getTime() - REPORT_GRACE_MS)));
  const start =
    cadence === "weekly"
      ? current.getTime() - 7 * DAY_MS
      : Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 1, 1);
  return periodFrom(cadence, start);
}

export function nextReportAt(cadence: ReportCadence, now = new Date()): Date {
  const current = currentStart(cadence, new Date(now.getTime() - REPORT_GRACE_MS));
  return new Date(periodFrom(cadence, current).end.getTime() + REPORT_GRACE_MS);
}
