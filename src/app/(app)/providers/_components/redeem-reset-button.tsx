"use client";

import { useState, useTransition } from "react";
import { Button, Spinner, toast, useOverlayState } from "@heroui/react";
import { TimerReset } from "lucide-react";
import { useTranslations } from "next-intl";
import ConfirmDialog from "@/components/console/confirm-dialog";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import type { LimitSnapshot, ProviderView } from "@/types/providers";
import type { ResetCredits, ResetOption, ResetResult } from "@/types/resets";
import { redeemProviderResetAction } from "../_action";
import ResetDialog from "./reset-dialog";
import { isSpendable, resetFlow, resetRefusal } from "./reset-view";
import { useResetLabels } from "./use-reset-labels";

type OpenDialog = "confirm" | "options";

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
  timeZone,
  onItem,
}: {
  row: ProviderView;
  credits: ResetCredits;
  timeZone: string;
  onItem: (item: LimitSnapshot | null) => void;
}) {
  const t = useTranslations("Subscriptions.resets");
  const tCommon = useTranslations("Common");
  const showError = useErrorToast();
  const labels = useResetLabels(timeZone, credits);
  const [pending, start] = useTransition();
  const [open, setOpen] = useState<OpenDialog | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const flow = resetFlow(credits);
  const retry = flow.mode === "retry";
  const dialog: OpenDialog = flow.mode === "choose" || flow.mode === "review" ? "options" : "confirm";
  const options = flow.mode === "choose" ? flow.options : flow.mode === "review" ? [flow.option] : [];
  const preferred = flow.mode === "choose" ? flow.initial : null;
  const selected =
    options.find((option) => option.id === picked && isSpendable(option)) ??
    options.find((option) => option.id === preferred) ??
    null;
  const reviewing = options.find((option) => option.id === reviewId) ?? null;
  const confirmState = useOverlayState({
    isOpen: open === "confirm" && dialog === "confirm",
    onOpenChange: (next) => setOpen(next ? "confirm" : null),
  });

  function show() {
    setPicked(null);
    setReviewId(flow.mode === "review" ? flow.option.id : null);
    setOpen(dialog);
  }

  function redeem(option: ResetOption | null) {
    start(async () => {
      const result = await redeemProviderResetAction({ id: row.id, ...(option ? { choice: option.id } : {}) });
      if (isActionFail(result)) {
        const refusal = resetRefusal(result.error);
        if (!refusal) {
          showError(result.error);
          return;
        }
        if (options.length > 1) setReviewId(null);
        toast(t("flow.refused", { reason: refusal.kind }), {
          description: refusal.kind === "blocker" ? labels.blocker(refusal.blocker, option) : undefined,
          variant: "warning",
        });
        return;
      }
      onItem(result.item);
      setOpen(null);
      toast(t("result", { result: result.result, windows: result.windowsReset }), {
        variant: RESULT_TOAST[result.result],
      });
    });
  }

  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        aria-label={t("useLabel", { retry: String(retry), name: row.name })}
        isPending={pending}
        onPress={show}
      >
        {({ isPending }) => (
          <>
            {isPending ? <Spinner color="current" size="sm" /> : <TimerReset size={14} aria-hidden />}
            {t("use", { retry: String(retry) })}
          </>
        )}
      </Button>
      <ConfirmDialog
        state={confirmState}
        title={t("confirmTitle", { retry: String(retry) })}
        description={retry ? t("confirmRetry", { name: row.name }) : t("confirmDescription", { kind: row.kind, name: row.name })}
        confirmLabel={t("confirm", { retry: String(retry) })}
        cancelLabel={tCommon("cancel")}
        status="warning"
        focusCancel
        pending={pending}
        onConfirm={() => redeem(null)}
      />
      <ResetDialog
        isOpen={open === "options" && dialog === "options"}
        name={row.name}
        credits={credits}
        options={options}
        selected={selected}
        reviewing={reviewing}
        stale={reviewId !== null && reviewing === null}
        timeZone={timeZone}
        pending={pending}
        onSelect={setPicked}
        onContinue={() => setReviewId(selected?.id ?? null)}
        onBack={() => setReviewId(null)}
        onConfirm={redeem}
        onClose={() => setOpen(null)}
      />
    </>
  );
}
