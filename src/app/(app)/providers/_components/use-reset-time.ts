"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useClock } from "@/lib/hooks/use-clock";
import { countdown, nearReset } from "./limit-timing";

const FULL_DATE = {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZoneName: "short",
} as const;
const NEAR_DATE = { weekday: "short", hour: "2-digit", minute: "2-digit" } as const;
const FAR_DATE = { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" } as const;

export function useResetTime(timeZone: string) {
  const t = useTranslations("Subscriptions.limits");
  const format = useFormatter();
  const now = useClock(60_000);

  function dateOptions(at: number, full: boolean) {
    if (full) return FULL_DATE;
    return nearReset(at, now.getTime()) ? NEAR_DATE : FAR_DATE;
  }

  return {
    now,
    countdown: (at: number) => t("countdown", countdown(at - now.getTime())),
    date: (at: number, full = false) => format.dateTime(new Date(at), { ...dateOptions(at, full), timeZone }),
  };
}
