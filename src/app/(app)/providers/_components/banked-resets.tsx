"use client";

import { Alert } from "@heroui/react";
import { TimerReset } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useClock } from "@/lib/hooks/use-clock";
import type { LimitSnapshot, ProviderView } from "@/types/providers";
import type { ResetCredits } from "@/types/resets";
import RedeemResetButton from "./redeem-reset-button";
import { ResetOptionChips, ResetOptionNotes } from "./reset-option-card";
import { canRedeemReset, resetOptions } from "./reset-view";
import { useResetLabels } from "./use-reset-labels";

export default function BankedResets({
  row,
  credits,
  timeZone,
  canManage,
  onItem,
}: {
  row: ProviderView;
  credits: ResetCredits;
  timeZone: string;
  canManage: boolean;
  onItem: (item: LimitSnapshot | null) => void;
}) {
  const t = useTranslations("Subscriptions.resets");
  const tLimits = useTranslations("Subscriptions.limits");
  const format = useFormatter();
  const now = useClock(60_000);
  const retry = credits.pending?.retryable === true;
  const labels = useResetLabels(timeZone, credits);
  const grants = credits.grants ?? [];
  const options = credits.pending ? [] : resetOptions(credits);
  const cooling = credits.cooldownUntil ? new Date(credits.cooldownUntil) : null;
  const waitingForLimit =
    credits.eligible === true &&
    !cooling &&
    credits.atLimit === false &&
    grants.some((grant) => grant.resetsLeft > 0) &&
    credits.applicable === 0;

  function stamp(iso: string) {
    return format.dateTime(new Date(iso), {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone,
      timeZoneName: "short",
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <TimerReset size={14} aria-hidden className="text-muted" />
          <p className="text-sm font-medium">{t("title")}</p>
        </div>
        {canRedeemReset(row, credits, canManage) ? <RedeemResetButton row={row} credits={credits} timeZone={timeZone} onItem={onItem} /> : null}
      </div>
      <p className="text-sm text-muted">
        {tLimits("resetCredits", { available: credits.available, applicable: credits.applicable })}
      </p>
      {credits.expiresAt ? (
        <p className="text-xs text-muted">
          {t("expires", { when: format.relativeTime(new Date(credits.expiresAt), now), date: stamp(credits.expiresAt) })}
        </p>
      ) : null}
      {options.length > 0 ? (
        <ul aria-label={t("listTitle")} className="space-y-3">
          {options.map((option) => (
            <li key={option.id} className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 break-words text-sm text-foreground">{labels.option(option)}</span>
                <ResetOptionChips option={option} />
              </div>
              <div className="space-y-1 text-xs text-muted">
                {option.refills.length > 0 || !option.givesBack ? <p>{labels.effect(option)}</p> : null}
                {option.givesBack ? (
                  <p>{labels.givesBack({ scope: option.givesBack.scope, percent: option.givesBack.percentOfWeekly })}</p>
                ) : null}
                <p>
                  {labels.left(option)} · {labels.expiry(option)}
                </p>
              </div>
              <ResetOptionNotes option={option} labels={labels} />
            </li>
          ))}
        </ul>
      ) : null}
      {credits.eligible === false ? (
        <p className="text-xs text-muted">{t("ineligible", { reason: credits.ineligibleReason ?? "unknown" })}</p>
      ) : null}
      {cooling && options.length === 0 ? (
        <p className="text-xs text-warning">
          {t("cooldown", { when: format.relativeTime(cooling, now), date: stamp(credits.cooldownUntil!) })}
        </p>
      ) : null}
      {waitingForLimit && options.length === 0 ? <p className="text-xs text-muted">{t("needsLimit")}</p> : null}
      {credits.pending ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content className="min-w-0">
            <Alert.Title>{t("pendingTitle")}</Alert.Title>
            <Alert.Description>
              {retry ? t("pendingRetry", { date: stamp(credits.pending.retryUntil) }) : t("pendingChecking")}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {row.kind === "claude" && credits.checkedAt ? (
        <p className="text-xs text-muted">{t("checked", { when: format.relativeTime(new Date(credits.checkedAt), now) })}</p>
      ) : null}
    </div>
  );
}
