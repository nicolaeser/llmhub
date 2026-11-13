import type { LimitGroup } from "@/types/providers";
import type { ResetLimit } from "@/types/resets";

export type LimitTone = "calm" | "rising" | "near" | "full_short" | "full_scoped" | "full";

export type LimitState = "ok" | "near" | "full";

export type ToneInput = { usedPercent: number | null; limitReached: boolean; short: boolean; scoped: boolean };

const FULL_PERCENT = 100;
const NEAR_PERCENT = 90;
const RISING_PERCENT = 80;
const SHORT_WINDOW_SECONDS = 86_400;

export function limitTone({ usedPercent, limitReached, short, scoped }: ToneInput): LimitTone {
  const used = usedPercent ?? 0;
  if (limitReached || used >= FULL_PERCENT) {
    if (short) return "full_short";
    return scoped ? "full_scoped" : "full";
  }
  if (used >= NEAR_PERCENT) return "near";
  if (used >= RISING_PERCENT) return "rising";
  return "calm";
}

export function groupTone(group: Pick<LimitGroup, "usedPercent" | "limitReached" | "windowSeconds" | "scoped">): LimitTone {
  return limitTone({
    usedPercent: group.usedPercent,
    limitReached: group.limitReached,
    short: group.windowSeconds > 0 && group.windowSeconds < SHORT_WINDOW_SECONDS,
    scoped: group.scoped,
  });
}

export function resetLimitTone(limit: Pick<ResetLimit, "usedPercent" | "limitReached" | "family">): LimitTone {
  return limitTone({
    usedPercent: limit.usedPercent,
    limitReached: limit.limitReached,
    short: limit.family === "five_hour",
    scoped: limit.family === "scoped" || limit.family === "other",
  });
}

export const TONE_STATE: Record<LimitTone, LimitState> = {
  calm: "ok",
  rising: "ok",
  near: "near",
  full_short: "full",
  full_scoped: "full",
  full: "full",
};

export type ToneColor = "accent" | "warning" | "danger";

export const TONE_COLOR: Record<LimitTone, ToneColor> = {
  calm: "accent",
  rising: "warning",
  near: "danger",
  full_short: "danger",
  full_scoped: "danger",
  full: "danger",
};

export function toneHue(tone: LimitTone): string {
  return `var(--${TONE_COLOR[tone]})`;
}

export const TONE_FILL: Record<LimitTone, string | undefined> = {
  calm: undefined,
  rising: undefined,
  near: "bg-danger/45",
  full_short: "bg-danger/62",
  full_scoped: "bg-danger/80",
  full: "bg-danger",
};

export const TONE_TEXT: Record<LimitTone, string | undefined> = {
  calm: undefined,
  rising: "text-warning",
  near: "text-danger",
  full_short: "text-danger",
  full_scoped: "text-danger",
  full: "text-danger",
};
