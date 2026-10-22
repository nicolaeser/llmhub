"use client";

import { useState, useTransition } from "react";
import { toast, useOverlayState } from "@heroui/react";
import { useTranslations } from "next-intl";
import ConfirmDialog from "@/components/console/confirm-dialog";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import type { ProviderView } from "@/types/providers";
import { deleteProviderAction, updateProviderAction } from "../_action";

export function useProviderRowActions({
  onReplace,
  onRemove,
}: {
  onReplace: (provider: ProviderView) => void;
  onRemove: (id: string) => void;
}) {
  const t = useTranslations("Providers");
  const tCommon = useTranslations("Common");
  const showError = useErrorToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [target, setTarget] = useState<ProviderView | null>(null);
  const [, start] = useTransition();
  const confirmState = useOverlayState();

  function setEnabled(row: ProviderView, enabled: boolean) {
    setBusy(row.id);
    start(async () => {
      const result = await updateProviderAction({ id: row.id, name: "", baseUrl: "", apiKey: "", enabled });
      setBusy(null);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onReplace(result.provider);
      toast(t("toasts.enabled", { enabled: String(result.provider.enabled), name: result.provider.name }), {
        variant: "success",
      });
    });
  }

  function askDisconnect(row: ProviderView) {
    setTarget(row);
    confirmState.open();
  }

  function disconnect() {
    if (!target) return;
    const row = target;
    setBusy(row.id);
    start(async () => {
      const result = await deleteProviderAction(row.id);
      setBusy(null);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onRemove(result.id);
      toast(t("toasts.saved", { mode: "deleted" }), { variant: "success" });
    });
  }

  const dialogs = (
    <ConfirmDialog
      state={confirmState}
      title={t("menu.disconnectTitle", { name: target?.name ?? "" })}
      description={t("deleteConfirm")}
      confirmLabel={t("menu.disconnect")}
      cancelLabel={tCommon("cancel")}
      onConfirm={disconnect}
    />
  );

  return { busy, setEnabled, askDisconnect, dialogs };
}
