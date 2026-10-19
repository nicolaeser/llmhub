"use client";

import { useSyncExternalStore } from "react";
import { isTimeZone } from "@/lib/gateway/billing/price-schedule";

const STORAGE_KEY = "llmhub.dashboard.time-zone";
const CHANGE_EVENT = "llmhub-dashboard-time-zone-change";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

function snapshot(): string {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value && isTimeZone(value) ? value : "UTC";
  } catch {
    return "UTC";
  }
}

function serverSnapshot(): string {
  return "UTC";
}

export function useDashboardTimeZone(): string {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

export function setDashboardTimeZone(value: string): void {
  if (!isTimeZone(value)) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    return;
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
