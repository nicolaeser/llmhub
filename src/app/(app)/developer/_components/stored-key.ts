"use client";

import { useSyncExternalStore } from "react";

const KEY_STORAGE = "llmhub.api-ref.bearer";
const keyListeners = new Set<() => void>();

function storageName(management: boolean): string {
  return management ? `${KEY_STORAGE}.management` : KEY_STORAGE;
}

function readStoredKey(name: string): string {
  try {
    return sessionStorage.getItem(name) ?? "";
  } catch {
    return "";
  }
}

function subscribeStoredKey(onStoreChange: () => void) {
  keyListeners.add(onStoreChange);
  return () => {
    keyListeners.delete(onStoreChange);
  };
}

function writeStoredKey(name: string, value: string) {
  try {
    if (value) sessionStorage.setItem(name, value);
    else sessionStorage.removeItem(name);
  } catch {
    return;
  }
  for (const listener of keyListeners) listener();
}

export function useStoredKey(management: boolean): readonly [string, (value: string) => void] {
  const name = storageName(management);
  const value = useSyncExternalStore(
    subscribeStoredKey,
    () => readStoredKey(name),
    () => "",
  );
  return [value, (next: string) => writeStoredKey(name, next)] as const;
}
