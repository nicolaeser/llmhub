"use client";

import { Disclosure, Label, Meter } from "@heroui/react";
import { useFormatter, useTranslations } from "next-intl";
import { meterColor } from "@/lib/utils/budget";
import type { LimitGroup } from "@/types/providers";
import KeyUsageBar, { KeyUsageLegend } from "./key-usage-bar";
import type { SegmentNamer } from "./key-usage-labels";
import type { BarSegment } from "./key-usage-view";
import { exhaustionAt } from "./limit-timing";
import { useResetTime } from "./use-reset-time";

export type MeterKeys = { segments: BarSegment[]; nameOf: SegmentNamer; shortNameOf: SegmentNamer };

const OUTPUT_TONE: Record<ReturnType<typeof meterColor>, string | undefined> = {
  accent: undefined,
  warning: "text-warning",
  danger: "text-danger",
};

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

export function useLimitLabel(): (group: Pick<LimitGroup, "scoped" | "family" | "label" | "windowSeconds">) => string {
  const t = useTranslations("Subscriptions.limits");
  return (group) => {
    const span = t("window", windowSpan(group.windowSeconds));
    const name = group.family ? t("group", { family: group.family }) : group.label;
    if (!group.scoped) return span;
    return group.windowSeconds > 0 ? t("scoped", { scope: name, window: span }) : name;
  };
}

export function ResetLine({
  at,
  reached,
  timeZone,
  full = false,
  stacked = false,
}: {
  at: number;
  reached: boolean;
  timeZone: string;
  full?: boolean;
  stacked?: boolean;
}) {
  const t = useTranslations("Subscriptions.limits");
  const reset = useResetTime(timeZone);
  return (
    <p className={reached ? "text-xs text-warning" : "text-xs text-muted"}>
      {t.rich("reset", {
        reached: String(reached),
        countdown: reset.countdown(at),
        date: reset.date(at, full),
        separator: (chunks) => (stacked ? null : chunks),
        time: (chunks) => (
          <time dateTime={new Date(at).toISOString()} className={stacked ? "block text-muted" : "whitespace-nowrap"}>
            {chunks}
          </time>
        ),
      })}
    </p>
  );
}

export default function LimitMeter({
  group,
  timeZone,
  compact = false,
  keys = null,
}: {
  group: LimitGroup;
  timeZone: string;
  compact?: boolean;
  keys?: MeterKeys | null;
}) {
  const t = useTranslations("Subscriptions.limits");
  const tKeys = useTranslations("Subscriptions.keyUsage");
  const format = useFormatter();
  const { now } = useResetTime(timeZone);
  const reset = group.resetsAt ? Date.parse(group.resetsAt) : NaN;
  const pending = Number.isFinite(reset) && reset > now.getTime();
  const runsOut = exhaustionAt(group, now.getTime());
  const used = group.usedPercent;
  const color = meterColor(used / 100);
  const label = useLimitLabel()(group);
  const listed = !compact && group.members.length > 1;
  const split = keys !== null && keys.segments.length > 0;

  return (
    <div className="min-w-0 space-y-1">
      <Meter
        value={used}
        color={color}
        aria-label={label}
        valueLabel={t("used", { used: used / 100, uniform: String(group.uniform) })}
      >
        <Label>{label}</Label>
        <Meter.Output className={split ? OUTPUT_TONE[color] : undefined} />
        {split ? null : (
          <Meter.Track>
            <Meter.Fill />
          </Meter.Track>
        )}
      </Meter>
      {split ? (
        <div className="space-y-1.5 pb-0.5">
          <KeyUsageBar
            size="sm"
            label={tKeys("barLabel", { window: label })}
            segments={keys.segments}
            used={used}
            nameOf={keys.nameOf}
            freeLabel={tKeys("free")}
          />
          <KeyUsageLegend label={tKeys("legend", { window: label })} segments={keys.segments} nameOf={keys.shortNameOf} />
        </div>
      ) : null}
      {pending ? <ResetLine at={reset} reached={group.limitReached} timeZone={timeZone} full={!compact} /> : null}
      {!pending && used === 0 ? <p className="text-xs text-muted">{t("notStarted")}</p> : null}
      {!pending && used > 0 ? (
        <p className={group.limitReached ? "text-xs text-warning" : "text-xs text-muted"}>
          {t("resetUnknown", { reached: String(group.limitReached) })}
        </p>
      ) : null}
      {runsOut !== null ? (
        <p className="text-xs text-warning">{t("pace", { when: format.relativeTime(new Date(runsOut), now) })}</p>
      ) : null}
      {listed ? (
        <Disclosure>
          <Disclosure.Heading>
            <Disclosure.Trigger className="flex w-full items-center justify-between gap-2 text-sm text-muted">
              {t("models", { count: group.members.length })}
              <Disclosure.Indicator />
            </Disclosure.Trigger>
          </Disclosure.Heading>
          <Disclosure.Content>
            <Disclosure.Body className="pt-1">
              {group.uniform ? (
                <p className="break-words text-xs text-muted">
                  {t("sharedBy", {
                    models: format.list(
                      group.members.map((member) => member.label),
                      { type: "conjunction" },
                    ),
                  })}
                </p>
              ) : (
                <ul className="space-y-0.5 text-xs text-muted">
                  {group.members.map((member) => (
                    <li key={member.scope} className="break-words">
                      {t("member", {
                        model: member.label,
                        used: member.usedPercent / 100,
                        reached: String(member.limitReached),
                      })}
                    </li>
                  ))}
                </ul>
              )}
            </Disclosure.Body>
          </Disclosure.Content>
        </Disclosure>
      ) : null}
    </div>
  );
}
