"use client";

import { TimerReset } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import type { LimitSnapshot, ProviderView } from "@/types/providers";
import type { ResetCredits } from "@/types/resets";
import RedeemResetButton from "./redeem-reset-button";
import { canRedeemReset, optionNaming, recommendedReset, resetOptions, resetWaitsFor } from "./reset-view";
import { useResetLabels } from "./use-reset-labels";

export default function ResetSummary({
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
  const labels = useResetLabels(timeZone, credits);
  const { reset, now } = labels;
  const recommended = recommendedReset(credits);
  const names = credits.pending ? [] : [...new Set(resetOptions(credits).map(labels.option))];
  const expiry = credits.expiresAt ? Date.parse(credits.expiresAt) : NaN;
  const cooldown = credits.cooldownUntil ? Date.parse(credits.cooldownUntil) : NaN;
  const waits = resetWaitsFor(credits, now);

  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0 flex-1 basis-40 space-y-0.5">
        <p className="flex items-center gap-1.5 text-xs text-foreground">
          <TimerReset size={12} aria-hidden className="shrink-0 text-muted" />
          {tLimits("resetCredits", { available: credits.available, applicable: credits.applicable })}
        </p>
        {recommended ? <p className="text-xs text-muted">{t("recommendedNow", optionNaming(recommended))}</p> : null}
        {!recommended && names.length > 0 ? <p className="break-words text-xs text-muted">{format.list(names)}</p> : null}
        {Number.isFinite(expiry) && expiry > now ? (
          <p className="text-xs text-muted">{t("expires", { when: reset.countdown(expiry), date: reset.date(expiry) })}</p>
        ) : null}
        {credits.pending ? <p className="text-xs text-warning">{t("pendingTitle")}</p> : null}
        {waits === "cooldown" ? (
          <p className="text-xs text-warning">{t("cooldown", { when: reset.countdown(cooldown), date: reset.date(cooldown) })}</p>
        ) : null}
        {waits === "limit" ? <p className="text-xs text-muted">{t("needsLimit")}</p> : null}
        {waits === "ineligible" ? (
          <p className="text-xs text-muted">{t("ineligible", { reason: credits.ineligibleReason ?? "unknown" })}</p>
        ) : null}
      </div>
      {canRedeemReset(row, credits, canManage) ? <RedeemResetButton row={row} credits={credits} timeZone={timeZone} onItem={onItem} /> : null}
    </div>
  );
}
