"use client";

import { useTransition } from "react";
import { Button, Description, Label, Spinner, Switch, toast } from "@heroui/react";
import { Download, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import ConfirmDialog from "@/components/console/confirm-dialog";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import type { UpdaterAction, UpdaterView } from "@/types/updates";
import { requestUpdaterAction, setAutoUpdateAction } from "../_action";

type ViewSetter = (view: UpdaterView | null) => void;

export function useUpdaterRequest(onView: ViewSetter) {
  const t = useTranslations("Common");
  const fail = useErrorToast();
  const [checking, startCheck] = useTransition();
  const [installing, startInstall] = useTransition();

  function request(action: UpdaterAction) {
    const begin = action === "check" ? startCheck : startInstall;
    begin(async () => {
      const result = await requestUpdaterAction(action);
      if (isActionFail(result)) {
        fail(result.error);
        return;
      }
      onView(result);
      toast.success(t("updater.requested", { action }));
    });
  }

  return { request, checking, installing };
}

export function useAutoUpdate(onView: ViewSetter) {
  const t = useTranslations("Common");
  const fail = useErrorToast();
  const [pending, start] = useTransition();

  function setAuto(enabled: boolean) {
    start(async () => {
      const result = await setAutoUpdateAction(enabled);
      if (isActionFail(result)) {
        fail(result.error);
        return;
      }
      onView(result);
      toast.success(t("updater.autoChanged", { enabled: enabled ? "true" : "false" }));
    });
  }

  return { setAuto, pending };
}

export function AutoUpdateSwitch({
  updater,
  onView,
  isDisabled = false,
}: {
  updater: UpdaterView;
  onView: ViewSetter;
  isDisabled?: boolean;
}) {
  const t = useTranslations("Common");
  const { setAuto, pending } = useAutoUpdate(onView);
  return (
    <Switch isSelected={updater.auto} onChange={setAuto} isDisabled={isDisabled || pending}>
      <Switch.Content>
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
        <Label>{t("updater.auto")}</Label>
      </Switch.Content>
      <Description>{updater.pinned ? t("updater.autoPinned") : t("updater.autoHint")}</Description>
    </Switch>
  );
}

export function UpdaterButtons({
  updater,
  onView,
  size = "md",
}: {
  updater: UpdaterView;
  onView: ViewSetter;
  size?: "sm" | "md";
}) {
  const t = useTranslations("Common");
  const { request, checking, installing } = useUpdaterRequest(onView);
  const offline = !updater.connected;
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        size={size}
        variant="secondary"
        isPending={checking || updater.pending === "check"}
        isDisabled={offline}
        onPress={() => request("check")}
      >
        {({ isPending }) => (
          <>
            {isPending ? <Spinner size="sm" color="current" /> : <RefreshCw size={14} aria-hidden />}
            {t("updater.check")}
          </>
        )}
      </Button>
      {!updater.pinned ? (
        <ConfirmDialog
          title={t("updater.updateTitle")}
          description={t("updater.updateDescription")}
          confirmLabel={t("updater.updateConfirm")}
          cancelLabel={t("cancel")}
          pending={installing}
          onConfirm={() => request("update")}
        >
          <Button
            size={size}
            variant={updater.available ? "primary" : "secondary"}
            isPending={installing || updater.pending === "update"}
            isDisabled={offline}
          >
            {({ isPending }) => (
              <>
                {isPending ? <Spinner size="sm" color="current" /> : <Download size={14} aria-hidden />}
                {t("updater.update")}
              </>
            )}
          </Button>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
