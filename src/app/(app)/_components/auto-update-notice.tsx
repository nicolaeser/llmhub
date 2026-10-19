"use client";

import { useSyncExternalStore } from "react";
import { Alert, Button, Spinner } from "@heroui/react";
import { useTranslations } from "next-intl";
import { useBuildStatus } from "./build-status";
import { useAutoUpdate } from "./updater-controls";

const DISMISS_KEY = "llmhub.autoUpdateNotice";
const DISMISS_EVENT = "llmhub:auto-update-notice";

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === "dismissed";
  } catch {
    return false;
  }
}

function writeDismissed(): boolean {
  try {
    window.localStorage.setItem(DISMISS_KEY, "dismissed");
    return true;
  } catch {
    return false;
  } finally {
    window.dispatchEvent(new Event(DISMISS_EVENT));
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(DISMISS_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(DISMISS_EVENT, onChange);
  };
}

export default function AutoUpdateNotice() {
  const t = useTranslations("Common");
  const status = useBuildStatus();
  const dismissed = useSyncExternalStore(subscribe, readDismissed, () => true);
  const { setAuto, pending } = useAutoUpdate((view) => status?.setUpdater(view));
  const live = status?.live;
  const updater = live?.updater;
  if (!live?.canManage || !updater?.connected || updater.auto || updater.pinned || dismissed) return null;

  return (
    <Alert status="accent" role="status" className="mb-5">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>{t("updater.noticeTitle")}</Alert.Title>
        <Alert.Description>{t("updater.noticeBody")}</Alert.Description>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" isPending={pending} onPress={() => setAuto(true)}>
            {({ isPending }) => (
              <>
                {isPending ? <Spinner size="sm" color="current" /> : null}
                {t("updater.noticeEnable")}
              </>
            )}
          </Button>
          <Button size="sm" variant="tertiary" isDisabled={pending} onPress={writeDismissed}>
            {t("updater.noticeLater")}
          </Button>
        </div>
      </Alert.Content>
    </Alert>
  );
}
