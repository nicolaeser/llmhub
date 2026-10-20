"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { toast } from "@heroui/react";
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
  const { setAuto } = useAutoUpdate((view) => status?.setUpdater(view));
  const enable = useRef(setAuto);
  const shown = useRef<string | null>(null);
  const live = status?.live;
  const updater = live?.updater;
  const offered = Boolean(live?.canManage && updater?.connected && !updater.auto && !updater.pinned && !dismissed);

  useEffect(() => {
    enable.current = setAuto;
  });

  useEffect(() => {
    if (!offered) {
      const open = shown.current;
      shown.current = null;
      if (open) toast.close(open);
      return;
    }
    if (shown.current) return;
    const key = toast(t("updater.noticeTitle"), {
      description: t("updater.noticeBody"),
      variant: "accent",
      timeout: 0,
      actionProps: { children: t("updater.noticeEnable"), onPress: () => enable.current(true) },
      onClose: () => {
        if (shown.current !== key) return;
        shown.current = null;
        writeDismissed();
      },
    });
    shown.current = key;
  }, [offered, t]);

  return null;
}
