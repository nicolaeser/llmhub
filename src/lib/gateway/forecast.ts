import { parseBudgetDurationMs } from "@/lib/gateway/period";
import type { BudgetForecast } from "@/types/gateway";

const MS_PER_DAY = 86_400_000;

export function spendWindow(
  entity: { budgetDuration: string; spendResetAt: Date | null; createdAt: Date },
  now = new Date(),
): { elapsedDays: number; remainingDays: number | null } {
  const start = (entity.spendResetAt ?? entity.createdAt).getTime();
  const elapsedDays = Math.max(0, now.getTime() - start) / MS_PER_DAY;
  const windowMs = parseBudgetDurationMs(entity.budgetDuration);
  const remainingDays =
    windowMs == null ? null : Math.max(0, start + windowMs - now.getTime()) / MS_PER_DAY;
  return { elapsedDays, remainingDays };
}

export function forecastBudget(
  spend: number,
  cap: number,
  elapsedDays: number,
  remainingDays: number | null = null,
): BudgetForecast {
  const days = Math.max(1, elapsedDays);
  const safeSpend = Number.isFinite(spend) ? Math.max(0, spend) : 0;
  const safeCap = Number.isFinite(cap) ? Math.max(0, cap) : 0;
  const dailyAvg = safeSpend / days;
  const projectedMonth = dailyAvg * 30;
  const remaining = safeCap > 0 ? Math.max(0, safeCap - safeSpend) : null;
  const exhaustIn =
    remaining != null && dailyAvg > 0 ? remaining / dailyAvg : null;
  const daysToExhaust =
    exhaustIn != null && remainingDays != null && exhaustIn > remainingDays
      ? null
      : exhaustIn;
  const pctUsed = safeCap > 0 ? Math.min(1, safeSpend / safeCap) : null;
  return { dailyAvg, projectedMonth, daysToExhaust, pctUsed };
}

export function crossedThresholds(
  pctUsed: number | null,
  thresholds: number[],
): number[] {
  if (pctUsed == null) return [];
  const pct = pctUsed * 100;
  return [...thresholds]
    .filter((n) => Number.isFinite(n) && n > 0 && pct >= n)
    .sort((a, b) => a - b);
}
