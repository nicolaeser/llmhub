"use client";

import { Button, Spinner } from "@heroui/react";
import { TimerReset } from "lucide-react";
import { useTranslations } from "next-intl";
import type { LimitSnapshot, ProviderView } from "@/types/providers";
import type { ResetCredits } from "@/types/resets";
import { useResetRedeem } from "./use-reset-redeem";

export function ResetButton({
  name,
  retry,
  pending,
  onPress,
}: {
  name: string;
  retry: boolean;
  pending: boolean;
  onPress: () => void;
}) {
  const t = useTranslations("Subscriptions.resets");
  return (
    <Button
      size="sm"
      variant="secondary"
      aria-label={t("useLabel", { retry: String(retry), name })}
      isPending={pending}
      onPress={onPress}
    >
      {({ isPending }) => (
        <>
          {isPending ? <Spinner color="current" size="sm" /> : <TimerReset size={14} aria-hidden />}
          {t("use", { retry: String(retry) })}
        </>
      )}
    </Button>
  );
}

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
  const redeem = useResetRedeem({ row, credits, timeZone, onItem });
  return (
    <>
      <ResetButton name={row.name} retry={redeem.retry} pending={redeem.pending} onPress={() => redeem.show()} />
      {redeem.dialogs}
    </>
  );
}
