"use client";

import { Disclosure, Label, Meter } from "@heroui/react";
import { OctagonAlert, TriangleAlert } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import type { LimitGroup } from "@/types/providers";
import KeyUsageBar, { KeyUsageLegend } from "./key-usage-bar";
import type { SegmentNamer } from "./key-usage-labels";
import type { BarSegment } from "./key-usage-view";
import { exhaustionAt } from "./limit-timing";
import { groupTone, TONE_COLOR, TONE_FILL, TONE_STATE, TONE_TEXT, type LimitState } from "./limit-tone";
import { useResetTime } from "./use-reset-time";

export type MeterKeys = { segments: BarSegment[]; nameOf: SegmentNamer; shortNameOf: SegmentNamer };

const RESET_LINE_TONE = { danger: "text-xs text-danger", warning: "text-xs text-warning" } as const;

export function LimitStateIcon({ state, size = 12 }: { state: LimitState; size?: number }) {
  if (state === "ok") return null;
  const Icon = state === "full" ? OctagonAlert : TriangleAlert;
  return <Icon size={size} aria-hidden className="shrink-0" />;
}

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
  tone = "danger",
}: {
  at: number;
  reached: boolean;
  timeZone: string;
  full?: boolean;
  stacked?: boolean;
  tone?: keyof typeof RESET_LINE_TONE;
}) {
  const t = useTranslations("Subscriptions.limits");
  const reset = useResetTime(timeZone);
  return (
    <p className={reached ? RESET_LINE_TONE[tone] : "text-xs text-muted"}>
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
  const resetTime = useResetTime(timeZone);
  const { now } = resetTime;
  const reset = group.resetsAt ? Date.parse(group.resetsAt) : NaN;
  const pending = Number.isFinite(reset) && reset > now.getTime();
  const runsOut = exhaustionAt(group, now.getTime());
  const used = group.usedPercent;
  const tone = groupTone(group);
  const state = TONE_STATE[tone];
  const label = useLimitLabel()(group);
  const listed = !compact && group.members.length > 1;
  const split = keys !== null && keys.segments.length > 0;

  return (
    <div className="min-w-0 space-y-1">
      <Meter
        value={used}
        color={TONE_COLOR[tone]}
        aria-label={label}
        valueLabel={t("used", { used: used / 100, uniform: String(group.uniform), state })}
      >
        {({ valueText }) => (
          <>
            <Label>{label}</Label>
            <Meter.Output
              className={`flex items-center justify-end gap-1 ${(split || state !== "ok" ? TONE_TEXT[tone] : undefined) ?? ""}`}
            >
              <LimitStateIcon state={state} />
              {valueText}
            </Meter.Output>
            {split ? null : (
              <Meter.Track>
                <Meter.Fill className={TONE_FILL[tone]} />
              </Meter.Track>
            )}
          </>
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
        <p className={group.limitReached ? "text-xs text-danger" : "text-xs text-muted"}>
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
                  {group.members.map((member) => {
                    const memberReset = member.resetsAt ? Date.parse(member.resetsAt) : NaN;
                    const timed = Number.isFinite(memberReset) && memberReset > now.getTime();
                    return (
                      <li key={member.scope} className="break-words">
                        {t("member", {
                          model: member.label,
                          used: member.usedPercent / 100,
                          reached: String(member.limitReached),
                          timed: String(timed),
                          countdown: timed ? resetTime.countdown(memberReset) : "",
                        })}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Disclosure.Body>
          </Disclosure.Content>
        </Disclosure>
      ) : null}
    </div>
  );
}
