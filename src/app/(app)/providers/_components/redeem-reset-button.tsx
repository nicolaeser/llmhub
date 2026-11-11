"use client";

import { useState, useTransition } from "react";
import { Button, Description, Label, Radio, RadioGroup, Spinner, toast } from "@heroui/react";
import { TimerReset } from "lucide-react";
import { useTranslations } from "next-intl";
import ConfirmDialog from "@/components/console/confirm-dialog";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import type { LimitSnapshot, ProviderView } from "@/types/providers";
import type { ResetCredits, ResetResult } from "@/types/resets";
import { redeemProviderResetAction } from "../_action";
import { resetChoices } from "./reset-view";
import { useResetTime } from "./use-reset-time";

const AUTOMATIC = "";

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
  const [pending, start] = useTransition();
  const [picked, setPicked] = useState(AUTOMATIC);
  const reset = useResetTime(timeZone);
  const retry = credits.pending?.retryable === true;
  const choices = resetChoices(credits);
  const choice = choices.some((item) => item.id === picked) ? picked : AUTOMATIC;

  function redeem() {
    start(async () => {
      const result = await redeemProviderResetAction({ id: row.id, ...(choice ? { choice } : {}) });
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
      body={
        choices.length ? (
          <RadioGroup value={choice} onChange={setPicked} className="gap-2">
            <Label>{t("choose")}</Label>
            <Radio value={AUTOMATIC}>
              <Radio.Control>
                <Radio.Indicator />
              </Radio.Control>
              <Radio.Content>
                <Label>{t("chooseAuto")}</Label>
                <Description>{t("chooseAutoHint", { kind: row.kind })}</Description>
              </Radio.Content>
            </Radio>
            {choices.map((item) => (
              <Radio key={item.id} value={item.id}>
                <Radio.Control>
                  <Radio.Indicator />
                </Radio.Control>
                <Radio.Content>
                  <Label className="break-words">
                    {item.kind === "credit"
                      ? t("chooseCredit", { titled: String(item.title !== ""), title: item.title })
                      : t("grant", { named: String(item.title !== ""), label: item.title })}
                  </Label>
                  <Description>
                    {t("chooseDetail", {
                      counted: String(item.kind === "grant"),
                      left: item.left,
                      total: item.total,
                      dated: String(item.expiresAt !== null),
                      date: item.expiresAt ? reset.date(Date.parse(item.expiresAt), true) : "",
                    })}
                  </Description>
                </Radio.Content>
              </Radio>
            ))}
          </RadioGroup>
        ) : undefined
      }
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
