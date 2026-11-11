"use client";

import { useEffect, useState } from "react";
import { Label, Meter } from "@heroui/react";
import { ArrowDown, ArrowRight, CircleCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ResetLimit } from "@/types/resets";
import { LimitStateIcon } from "./limit-meter";
import { limitTone, resetLimitTone, TONE_COLOR, TONE_FILL, TONE_STATE, TONE_TEXT, type LimitTone } from "./limit-tone";
import type { LimitEffect } from "./reset-view";

const FULL_PERCENT = 100;
const OUTPUT = "flex items-center justify-end gap-1";

function usageState(tone: LimitTone, used: number | null, reached: boolean): string {
  if (used === null) return reached ? "full_unknown" : "unknown";
  return TONE_STATE[tone];
}

function afterTone(limit: ResetLimit, after: number): LimitTone {
  return limitTone({
    usedPercent: after,
    limitReached: false,
    short: limit.family === "five_hour",
    scoped: limit.family === "scoped" || limit.family === "other",
  });
}

export default function ResetLimitBar({ limit, name }: { limit: ResetLimit; name: string }) {
  const t = useTranslations("Subscriptions.resets");
  const tone = resetLimitTone(limit);
  const used = limit.usedPercent;
  return (
    <Meter
      size="sm"
      value={used ?? (limit.limitReached ? FULL_PERCENT : 0)}
      color={TONE_COLOR[tone]}
      aria-label={name}
      valueLabel={t("limit.usage", { state: usageState(tone, used, limit.limitReached), used: (used ?? 0) / 100 })}
    >
      {({ valueText }) => (
        <>
          <Label>{name}</Label>
          <Meter.Output className={`${OUTPUT} ${TONE_TEXT[tone] ?? "text-muted"}`}>
            <LimitStateIcon state={TONE_STATE[tone]} />
            {valueText}
          </Meter.Output>
          <Meter.Track>
            <Meter.Fill className={TONE_FILL[tone]} />
          </Meter.Track>
        </>
      )}
    </Meter>
  );
}

export function ResetEffectRow({ effect, name }: { effect: LimitEffect; name: string }) {
  const t = useTranslations("Subscriptions.resets");
  const [settled, setSettled] = useState(false);
  const { limit, before, after } = effect;
  const tone = resetLimitTone(limit);
  const start = before ?? 0;
  const end = after ?? start;
  const endTone = afterTone(limit, end);
  const freed = endTone === "calm";

  useEffect(() => {
    const frame = requestAnimationFrame(() => setSettled(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="space-y-2">
      <p className="break-words text-sm font-medium text-foreground">{name}</p>
      <div className="grid grid-cols-1 items-end gap-x-3 gap-y-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <Meter
          size="sm"
          value={start}
          color={TONE_COLOR[tone]}
          aria-label={t("flow.nowLabel", { limit: name })}
          valueLabel={t("limit.usage", { state: usageState(tone, before, limit.limitReached), used: start / 100 })}
        >
          {({ valueText }) => (
            <>
              <Label className="text-muted">{t("flow.now")}</Label>
              <Meter.Output className={`${OUTPUT} ${TONE_TEXT[tone] ?? ""}`}>
                <LimitStateIcon state={TONE_STATE[tone]} />
                {valueText}
              </Meter.Output>
              <Meter.Track>
                <Meter.Fill className={TONE_FILL[tone]} />
              </Meter.Track>
            </>
          )}
        </Meter>
        <span className="flex justify-center pb-0.5 text-muted" aria-hidden>
          <ArrowRight size={16} className="hidden sm:block" />
          <ArrowDown size={16} className="sm:hidden" />
        </span>
        <Meter
          size="sm"
          value={settled ? end : start}
          color={freed ? "success" : TONE_COLOR[endTone]}
          aria-label={t("flow.afterLabel", { limit: name })}
          valueLabel={t("limit.usage", { state: TONE_STATE[endTone], used: end / 100 })}
        >
          {({ valueText }) => (
            <>
              <Label className="text-muted">{t("flow.after")}</Label>
              <Meter.Output className={`${OUTPUT} ${freed ? "text-success" : (TONE_TEXT[endTone] ?? "")}`}>
                {freed ? <CircleCheck size={12} aria-hidden className="shrink-0" /> : <LimitStateIcon state={TONE_STATE[endTone]} />}
                {valueText}
              </Meter.Output>
              <Meter.Track>
                <Meter.Fill className={freed ? undefined : TONE_FILL[endTone]} />
              </Meter.Track>
            </>
          )}
        </Meter>
      </div>
    </div>
  );
}
