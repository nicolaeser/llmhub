"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useTimeZone } from "next-intl";
import { notifyPreferenceChange, onPreferenceChange } from "@/lib/utils/preference-sync";
import {
  browserTimeZone,
  cookieTimeZone,
  FALLBACK_TIME_ZONE,
  preferredTimeZone,
  timeZoneFromCookieHeader,
  writeTimeZoneCookie,
} from "@/lib/utils/time-zone-cookie";

const LEGACY_STORAGE_KEY = "llmhub.dashboard.time-zone";

const listeners = new Set<() => void>();
let selected: string | null = null;
let stopSync: (() => void) | null = null;

function legacyTimeZone(): string | null {
  try {
    return window.localStorage.getItem(LEGACY_STORAGE_KEY);
  } catch {
    return null;
  }
}

function forgetLegacyTimeZone() {
  try {
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    return;
  }
}

function storedTimeZone(): string | null {
  return timeZoneFromCookieHeader(document.cookie);
}

function notify() {
  for (const listener of listeners) listener();
}

function syncStoredTimeZone() {
  const stored = storedTimeZone();
  if (!stored || stored === selected) return;
  selected = stored;
  notify();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  if (listeners.size === 1) stopSync = onPreferenceChange("time-zone", syncStoredTimeZone);
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0) {
      stopSync?.();
      stopSync = null;
    }
  };
}

export function consoleTimeZone(): string {
  selected ??= preferredTimeZone({ cookie: storedTimeZone(), legacy: legacyTimeZone(), browser: browserTimeZone() });
  return selected;
}

function persistConsoleTimeZone() {
  const timeZone = consoleTimeZone();
  if (storedTimeZone() !== timeZone) writeTimeZoneCookie(timeZone);
  forgetLegacyTimeZone();
}

export function setConsoleTimeZone(value: string) {
  const timeZone = cookieTimeZone(value);
  if (!timeZone) return;
  writeTimeZoneCookie(timeZone);
  if (timeZone !== selected) {
    selected = timeZone;
    notify();
  }
  notifyPreferenceChange("time-zone");
}

export function useConsoleTimeZone(): string {
  return useTimeZone() ?? FALLBACK_TIME_ZONE;
}

export function useSelectedConsoleTimeZone(): string {
  const requestTimeZone = useConsoleTimeZone();
  const timeZone = useSyncExternalStore(subscribe, consoleTimeZone, () => requestTimeZone);
  useEffect(persistConsoleTimeZone, []);
  return timeZone;
}
