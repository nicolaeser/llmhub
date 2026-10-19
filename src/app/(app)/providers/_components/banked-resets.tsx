"use client";

import { useTransition } from "react";
import { Alert, Button, Chip, Spinner, toast } from "@heroui/react";
import { TimerReset } from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import ConfirmDialog from "@/components/console/confirm-dialog";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import type { ProviderView, SubscriptionLimits } from "@/types/providers";
import type { ResetCredits, ResetResult } from "@/types/resets";
import { redeemProviderResetAction } from "../_action";

const RESULT_TOAST = {
  reset: "success",
  already_redeemed: "success",
  already_used: "success",
  nothing_to_reset: "warning",
  no_credit: "warning",
  not_limited: "warning",
  cooldown: "warning",
  ineligible: "warning",
  unavailable: "warning",
  rate_limited: "warning",
  auth_error: "danger",
  unknown: "warning",
} as const satisfies Record<ResetResult, "success" | "warning" | "danger">;

export default function BankedResets({
  row,
  credits,
  timeZone,
  canManage,
  onLimits,
}: {
  row: ProviderView;
  credits: ResetCredits;
  timeZone: string;
  canManage: boolean;
  onLimits: (id: string, limits: SubscriptionLimits | null) => void;
}) {
  const t = useTranslations("Subscriptions.resets");
  const tLimits = useTranslations("Subscriptions.limits");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const showError = useErrorToast();
  const [pending, start] = useTransition();
  const retry = credits.pending?.retryable === true;
  const canPress = canManage && credits.canRedeem === true && row.signIn?.status === "active";
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

  function redeem() {
    start(async () => {
      const result = await redeemProviderResetAction({ id: row.id });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onLimits(row.id, result.limits);
      toast(t("result", { result: result.result, windows: result.windowsReset }), {
        variant: RESULT_TOAST[result.result],
      });
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <TimerReset size={14} aria-hidden className="text-muted" />
          <p className="text-sm font-medium">{t("title")}</p>
        </div>
        {canPress ? (
          <ConfirmDialog
            title={t("confirmTitle", { retry: String(retry) })}
            description={
              retry
                ? t("confirmRetry", { name: row.name })
                : t("confirmDescription", { kind: row.kind, name: row.name })
            }
            confirmLabel={t("confirm", { retry: String(retry) })}
            cancelLabel={tCommon("cancel")}
            status="warning"
            focusCancel
            pending={pending}
            onConfirm={redeem}
          >
            <Button
              size="sm"
              variant="secondary"
              aria-label={t("useLabel", { retry: String(retry), name: row.name })}
              isPending={pending}
            >
              {({ isPending }) => (
                <>
                  {isPending ? <Spinner color="current" size="sm" /> : <TimerReset size={14} aria-hidden />}
                  {t("use", { retry: String(retry) })}
                </>
              )}
            </Button>
          </ConfirmDialog>
        ) : null}
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
