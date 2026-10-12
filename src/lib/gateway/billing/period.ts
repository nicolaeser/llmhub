const MS_PER_DAY = 86_400_000;

export function parseBudgetDurationMs(duration: string): number | null {
  const raw = duration.trim().toLowerCase();
  if (!raw) return null;
  if (raw === "daily" || raw === "1d") return MS_PER_DAY;
  if (raw === "weekly" || raw === "7d") return 7 * MS_PER_DAY;
  if (raw === "monthly" || raw === "1mo" || raw === "30d") return 30 * MS_PER_DAY;
  const match = /^(\d+)d$/.exec(raw);
  if (!match) return null;
  const days = Number(match[1]);
  if (!Number.isFinite(days) || days <= 0) return null;
  return days * MS_PER_DAY;
}

export function periodElapsed(
  duration: string,
  resetAt: Date | null | undefined,
  now: Date,
  createdAt?: Date | null,
): boolean {
  const windowMs = parseBudgetDurationMs(duration);
  if (windowMs == null) return false;
  const start = resetAt ?? createdAt ?? now;
  return now.getTime() - start.getTime() >= windowMs;
}

export function capExceeded(
  spend: number,
  maxBudget: number,
  extra = 0,
): boolean {
  if (!(maxBudget > 0)) return false;
  return spend >= maxBudget + extra;
}

