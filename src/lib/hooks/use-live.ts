"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { liveLink, liveTopicValue, watchLiveLink, watchLiveTopic } from "@/lib/updates/live-client";
import { mergeLimits, newestOf, removedSince } from "@/lib/updates/live-events";
import type { LiveLimitsView, LiveRequests, LiveTopic, LiveTopicValues, UsageToday } from "@/types/live";
import type { LimitSnapshotList } from "@/types/providers";

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

export function useLiveLimits(seed: LimitSnapshotList | null): LiveLimitsView {
  const live = useLiveTopic("limits");
  return useMemo(() => ({ items: mergeLimits(seed, live), removed: removedSince(seed, live) }), [seed, live]);
}

export function useLiveRequests(): LiveRequests | null {
  return useLiveTopic("requests");
}

export function useLiveUsageToday(seed: UsageToday | null): UsageToday | null {
  return newestOf(seed, useLiveTopic("usage"));
}
