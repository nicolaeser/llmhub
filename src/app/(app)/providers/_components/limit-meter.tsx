"use client";

import { Badge, Label, Meter } from "@heroui/react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { meterColor } from "@/lib/utils/budget";
import type { LimitWindow } from "@/types/providers";

const DAY_SECONDS = 86_400;
const HOUR_SECONDS = 3_600;

const MONTH_MIN_DAYS = 28;
const MONTH_MAX_DAYS = 31;

function windowSpan(seconds: number): { unit: string; count: number } {
  if (seconds >= MONTH_MIN_DAYS * DAY_SECONDS && seconds <= MONTH_MAX_DAYS * DAY_SECONDS) {
    return { unit: "month", count: 1 };
  }
  if (seconds >= DAY_SECONDS && seconds % DAY_SECONDS === 0) return { unit: "day", count: seconds / DAY_SECONDS };
  if (seconds >= HOUR_SECONDS) return { unit: "hour", count: Math.round(seconds / HOUR_SECONDS) };
  return { unit: "other", count: 0 };
}

export default function LimitMeter({
  window,
  scoped,
}: {
  window: LimitWindow;
  scoped?: boolean;
}) {
  const t = useTranslations("Subscriptions.limits");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const resetsAt = window.resetsAt ? new Date(window.resetsAt) : null;
  const renewed = resetsAt !== null && resetsAt.getTime() <= now.getTime();
  const used = renewed ? 0 : window.usedPercent;
  const span = t("window", windowSpan(window.windowSeconds));
  const label = scoped && window.scope ? t("scoped", { scope: window.scope, window: span }) : span;

  return (
    <div className="min-w-0 space-y-1">
      <Meter value={used} color={meterColor(used / 100)} aria-label={label}>
        <Label>{label}</Label>
        <Meter.Output />
        <Meter.Track>
          <Meter.Fill />
        </Meter.Track>
      </Meter>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        {resetsAt && !renewed ? (
          <span>
            {t("resets", {
              when: format.relativeTime(resetsAt, now),
              date: format.dateTime(resetsAt, {
                weekday: "short",
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              }),
            })}
          </span>
        ) : null}
        {!resetsAt && used === 0 ? <span>{t("notStarted")}</span> : null}
        {!renewed && window.limitReached ? (
          <Badge size="sm" variant="soft" color="danger" className="px-1.5 whitespace-nowrap">
            {t("reached")}
          </Badge>
        ) : null}
      </div>
    </div>
  );
}
