"use client";

import { useTransition } from "react";
import { Button, Spinner, toast } from "@heroui/react";
import { TimerReset } from "lucide-react";
import { useTranslations } from "next-intl";
import ConfirmDialog from "@/components/console/confirm-dialog";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import type { LimitSnapshot, ProviderView } from "@/types/providers";
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

export default function RedeemResetButton({
  row,
  credits,
  onItem,
}: {
  row: ProviderView;
  credits: ResetCredits;
  onItem: (item: LimitSnapshot | null) => void;
}) {
  const t = useTranslations("Subscriptions.resets");
  const tCommon = useTranslations("Common");
  const showError = useErrorToast();
  const [pending, start] = useTransition();
  const retry = credits.pending?.retryable === true;

  function redeem() {
    start(async () => {
      const result = await redeemProviderResetAction({ id: row.id });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onItem(result.item);
      toast(t("result", { result: result.result, windows: result.windowsReset }), {
        variant: RESULT_TOAST[result.result],
      });
    });
  }

  return (
    <ConfirmDialog
      title={t("confirmTitle", { retry: String(retry) })}
      description={retry ? t("confirmRetry", { name: row.name }) : t("confirmDescription", { kind: row.kind, name: row.name })}
      confirmLabel={t("confirm", { retry: String(retry) })}
      cancelLabel={tCommon("cancel")}
      status="warning"
      focusCancel
      pending={pending}
      onConfirm={redeem}
    >
      <Button size="sm" variant="secondary" aria-label={t("useLabel", { retry: String(retry), name: row.name })} isPending={pending}>
        {({ isPending }) => (
          <>
            {isPending ? <Spinner color="current" size="sm" /> : <TimerReset size={14} aria-hidden />}
            {t("use", { retry: String(retry) })}
          </>
        )}
      </Button>
    </ConfirmDialog>
  );
}
