"use client";

import { useSyncExternalStore } from "react";
import { onPreferenceChange } from "@/lib/utils/preference-sync";
import { sidebarCollapsedFromCookieHeader } from "@/lib/utils/sidebar-cookie";

function subscribe(listener: () => void) {
  return onPreferenceChange("sidebar", listener);
}

export function useSidebarCollapsed(initial: boolean): boolean {
  return useSyncExternalStore(
    subscribe,
    () => sidebarCollapsedFromCookieHeader(document.cookie) ?? initial,
    () => initial,
  );
}
