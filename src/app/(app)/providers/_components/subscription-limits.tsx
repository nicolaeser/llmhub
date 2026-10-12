"use client";

import { useEffect, useState, useTransition } from "react";
import { Button, Chip, Label, Meter, Skeleton, Spinner } from "@heroui/react";
import { RefreshCw } from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { loadProviderLimitsAction } from "@/app/(app)/providers/_action";
import { isActionFail } from "@/lib/http/action-result";
import { meterColor } from "@/lib/utils/budget";
import type { LimitWindow, SubscriptionLimits } from "@/types/providers";

const DAY_SECONDS = 86_400;
const HOUR_SECONDS = 3_600;

function windowSpan(seconds: number): { unit: string; count: number } {
  if (seconds >= DAY_SECONDS && seconds % DAY_SECONDS === 0) return { unit: "day", count: seconds / DAY_SECONDS };
  if (seconds >= HOUR_SECONDS) return { unit: "hour", count: Math.round(seconds / HOUR_SECONDS) };
  return { unit: "other", count: 0 };
}

function scopes(windows: LimitWindow[]): [string, LimitWindow[]][] {
  const grouped = new Map<string, LimitWindow[]>();
  for (const window of windows) grouped.set(window.scope, [...(grouped.get(window.scope) ?? []), window]);
  return [...grouped.entries()];
}

export default function SubscriptionLimitsView({ providerId }: { providerId: string }) {
  const t = useTranslations("Providers.limits");
  const tError = useTranslations("Error");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const [limits, setLimits] = useState<SubscriptionLimits | null>(null);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();

  useEffect(() => {
    let active = true;
    loadProviderLimitsAction({ id: providerId }).then((result) => {
      if (!active) return;
      if (isActionFail(result)) setError(result.error);
      else setLimits(result.limits);
    });
    return () => {
      active = false;
    };
  }, [providerId]);

  function refresh() {
    start(async () => {
      const result = await loadProviderLimitsAction({ id: providerId, refresh: true });
      if (isActionFail(result)) {
        setError(result.error);
        return;
      }
      setError("");
      setLimits(result.limits);
    });
  }

  if (!limits && !error) {
    return (
      <div className="w-full space-y-2" aria-hidden>
        <Skeleton className="h-3 w-1/3 rounded-lg" />
        <Skeleton className="h-2 w-full rounded-lg" />
      </div>
    );
  }

  return (
    <div className="w-full space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-foreground">{t("title")}</p>
        <Button isIconOnly size="sm" variant="tertiary" aria-label={t("refresh")} isPending={pending} onPress={refresh}>
          {({ isPending }) => (isPending ? <Spinner color="current" size="sm" /> : <RefreshCw size={14} aria-hidden />)}
        </Button>
      </div>
      {error ? <p className="text-xs text-warning">{tError("code", { code: error })}</p> : null}
      {limits && limits.windows.length === 0 ? <p className="text-xs text-muted">{t("none")}</p> : null}
      {limits
        ? scopes(limits.windows).map(([scope, windows]) => (
            <div key={scope || "plan"} className="space-y-2">
              {scope ? <p className="text-xs text-muted">{scope}</p> : null}
              {windows.map((window, index) => {
                const span = windowSpan(window.windowSeconds);
                const resetsAt = window.resetsAt ? new Date(window.resetsAt) : null;
                return (
                  <div key={`${scope}-${index}`} className="space-y-1">
                    <Meter
                      value={window.usedPercent}
                      color={meterColor(window.usedPercent / 100)}
                      aria-label={t("window", span)}
                    >
                      <Label>{t("window", span)}</Label>
                      <Meter.Output />
                      <Meter.Track>
                        <Meter.Fill />
                      </Meter.Track>
                    </Meter>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                      {resetsAt ? (
                        <span>{t("resets", { when: format.relativeTime(resetsAt, now) })}</span>
                      ) : null}
                      {window.limitReached ? (
                        <Chip size="sm" variant="soft" color="danger">
                          {t("reached")}
                        </Chip>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ))
        : null}
      {limits?.credits ? (
        <p className="text-xs text-muted">
          {t("credits", { unlimited: limits.credits.unlimited ? "true" : "false", balance: limits.credits.balance })}
        </p>
      ) : null}
    </div>
  );
}
