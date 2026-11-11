"use client";

import { Alert, Chip } from "@heroui/react";
import { TimerReset } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useClock } from "@/lib/hooks/use-clock";
import type { LimitSnapshot, ProviderView } from "@/types/providers";
import type { ResetCredits } from "@/types/resets";
import RedeemResetButton from "./redeem-reset-button";
import { canRedeemReset } from "./reset-view";

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
  const grants = credits.grants ?? [];
  const listed = credits.credits ?? [];
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
      {listed.length > 1 ? (
        <ul className="space-y-1 text-xs text-muted">
          {listed.map((credit) => (
            <li key={credit.id} className="break-words">
              {t("credit", {
                titled: String(credit.title !== ""),
                title: credit.title,
                dated: String(credit.expiresAt !== null),
                date: credit.expiresAt ? stamp(credit.expiresAt) : "",
              })}
            </li>
          ))}
        </ul>
      ) : null}
      {grants.length > 0 ? (
        <ul className="space-y-2">
          {grants.map((grant) => (
            <li key={grant.id} className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 break-words text-sm">
                  {t("grant", { named: String(grant.label !== ""), label: grant.label })}
                </span>
                {grant.usable ? (
                  <Chip size="sm" variant="soft" color="success" className="whitespace-nowrap">
                    {t("usable")}
                  </Chip>
                ) : null}
              </div>
              <p className="text-xs text-muted">
                {t("grantLeft", { left: grant.resetsLeft, total: grant.resetsTotal })}
                {grant.clears.length > 0
                  ? ` · ${t("clears", {
                      windows: format.list(grant.clears.map((window) => t("window", { window }))),
                    })}`
                  : ""}
                {grant.endsAt ? ` · ${t("grantEnds", { date: stamp(grant.endsAt) })}` : ""}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
      {credits.eligible === false ? (
        <p className="text-xs text-muted">{t("ineligible", { reason: credits.ineligibleReason ?? "unknown" })}</p>
      ) : null}
      {cooling ? (
        <p className="text-xs text-warning">
          {t("cooldown", { when: format.relativeTime(cooling, now), date: stamp(credits.cooldownUntil!) })}
        </p>
      ) : null}
      {waitingForLimit ? <p className="text-xs text-muted">{t("needsLimit")}</p> : null}
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
