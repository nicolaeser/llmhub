"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { liveLink, liveTopicValue, watchLiveLink, watchLiveTopic } from "@/lib/updates/live-client";
import { mergeLimits, newestOf } from "@/lib/updates/live-events";
import type { LiveRequests, LiveTopic, LiveTopicValues, UsageToday } from "@/types/live";
import type { LimitSnapshot, LimitSnapshotList } from "@/types/providers";

export function useLiveTopic<T extends LiveTopic>(topic: T): LiveTopicValues[T] | null {
  const subscribe = useCallback((onChange: () => void) => watchLiveTopic(topic, onChange), [topic]);
  return useSyncExternalStore(
    subscribe,
    () => liveTopicValue(topic),
    () => null,
  );
}

export function useLiveConnected(): boolean {
  return useSyncExternalStore(
    watchLiveLink,
    () => liveLink() === "open",
    () => false,
  );
}

export function useLiveLimits(seed: LimitSnapshotList | null): Record<string, LimitSnapshot> {
  const live = useLiveTopic("limits");
  return useMemo(() => mergeLimits(seed, live), [seed, live]);
}

export function useLiveRequests(): LiveRequests | null {
  return useLiveTopic("requests");
}

export function useLiveUsageToday(seed: UsageToday | null): UsageToday | null {
  return newestOf(seed, useLiveTopic("usage"));
}
