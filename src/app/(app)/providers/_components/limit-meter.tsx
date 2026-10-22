"use client";

import { Chip, Disclosure, Label, Meter } from "@heroui/react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { meterColor } from "@/lib/utils/budget";
import type { LimitGroup } from "@/types/providers";

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
  group,
  timeZone,
  compact = false,
}: {
  group: LimitGroup;
  timeZone: string;
  compact?: boolean;
}) {
  const t = useTranslations("Subscriptions.limits");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const resetsAt = group.resetsAt ? new Date(group.resetsAt) : null;
  const pending = resetsAt !== null && resetsAt.getTime() > now.getTime();
  const used = group.usedPercent;
  const span = t("window", windowSpan(group.windowSeconds));
  const name = group.family ? t("group", { family: group.family }) : group.label;
  const scopedLabel = group.windowSeconds > 0 ? t("scoped", { scope: name, window: span }) : name;
  const label = group.scoped ? scopedLabel : span;
  const listed = group.members.length > 1;

  const meter = (
    <Meter
      value={used}
      color={meterColor(used / 100)}
      aria-label={label}
      valueLabel={group.uniform ? format.number(used / 100, { style: "percent" }) : t("upTo", { used: used / 100 })}
    >
      <Label>{label}</Label>
      <Meter.Output />
      <Meter.Track>
        <Meter.Fill />
      </Meter.Track>
    </Meter>
  );

  if (compact) return <div className="min-w-0">{meter}</div>;

  return (
    <div className="min-w-0 space-y-1">
      {meter}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        {resetsAt && pending ? (
          <span>
            {t("resets", {
              when: format.relativeTime(resetsAt, now),
              date: format.dateTime(resetsAt, {
                weekday: "short",
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
                timeZone,
                timeZoneName: "short",
              }),
            })}
          </span>
        ) : null}
        {!resetsAt && used === 0 ? <span>{t("notStarted")}</span> : null}
        {group.limitReached ? (
          <Chip size="sm" variant="soft" color="danger" className="whitespace-nowrap">
            {t("reached")}
          </Chip>
        ) : null}
      </div>
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
