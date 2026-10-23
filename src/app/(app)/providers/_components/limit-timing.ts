import type { LimitGroup } from "@/types/providers";

const MINUTE_MS = 60_000;
const HOUR_MINUTES = 60;
const DAY_MINUTES = 1_440;
const DAY_SECONDS = 86_400;
const FULL_PERCENT = 100;
const NEAR_RESET_MS = 6 * DAY_SECONDS * 1_000;
const PACE_MIN_WINDOW_SECONDS = DAY_SECONDS;
const PACE_MIN_ELAPSED = 0.25;
const PACE_MIN_SHORTFALL = 0.1;

export type Countdown = { unit: "days" | "hours" | "minutes"; days: number; hours: number; minutes: number };

export function countdown(ms: number): Countdown {
  const total = Math.max(1, Math.ceil(ms / MINUTE_MS));
  const days = Math.floor(total / DAY_MINUTES);
  const hours = Math.floor((total % DAY_MINUTES) / HOUR_MINUTES);
  const minutes = total % HOUR_MINUTES;
  return { unit: days > 0 ? "days" : hours > 0 ? "hours" : "minutes", days, hours, minutes };
}

export function nearReset(at: number, now: number): boolean {
  return at - now < NEAR_RESET_MS;
}

export function exhaustionAt(
  group: Pick<LimitGroup, "usedPercent" | "resetsAt" | "windowSeconds" | "limitReached">,
  now: number,
): number | null {
  if (group.limitReached || group.usedPercent <= 0 || group.windowSeconds < PACE_MIN_WINDOW_SECONDS) return null;
  const reset = group.resetsAt ? Date.parse(group.resetsAt) : NaN;
  if (!Number.isFinite(reset) || reset <= now) return null;
  const span = group.windowSeconds * 1_000;
  const start = reset - span;
  const elapsed = now - start;
  if (elapsed < span * PACE_MIN_ELAPSED) return null;
  const at = start + (elapsed * FULL_PERCENT) / group.usedPercent;
  return at > now && reset - at >= span * PACE_MIN_SHORTFALL ? at : null;
}
