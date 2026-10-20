import { applyLiveEvent, LIVE_TOPICS } from "@/lib/updates/live-events";
import type { LiveTopic, LiveTopicValues } from "@/types/live";
import type { LiveLink } from "@/types/updates";

type LiveStore = {
  counts: Map<LiveTopic, number>;
  values: Partial<{ [T in LiveTopic]: LiveTopicValues[T] }>;
  listeners: Set<() => void>;
  topicListeners: Set<() => void>;
  link: LiveLink;
};

const store: LiveStore = {
  counts: new Map(),
  values: {},
  listeners: new Set(),
  topicListeners: new Set(),
  link: "connecting",
};

function emit(): void {
  for (const listener of [...store.listeners]) listener();
}

function topicsChanged(): void {
  for (const listener of [...store.topicListeners]) listener();
}

export function wantedLiveTopics(): LiveTopic[] {
  return LIVE_TOPICS.filter((topic) => (store.counts.get(topic) ?? 0) > 0);
}

export function onWantedLiveTopics(listener: () => void): () => void {
  store.topicListeners.add(listener);
  return () => {
    store.topicListeners.delete(listener);
  };
}

export function watchLiveTopic(topic: LiveTopic, onChange: () => void): () => void {
  const before = store.counts.get(topic) ?? 0;
  store.counts.set(topic, before + 1);
  store.listeners.add(onChange);
  if (before === 0) topicsChanged();
  return () => {
    store.listeners.delete(onChange);
    const left = (store.counts.get(topic) ?? 1) - 1;
    if (left > 0) {
      store.counts.set(topic, left);
      return;
    }
    store.counts.delete(topic);
    delete store.values[topic];
    topicsChanged();
  };
}

export function liveTopicValue<T extends LiveTopic>(topic: T): LiveTopicValues[T] | null {
  return (store.values[topic] as LiveTopicValues[T] | undefined) ?? null;
}

export function receiveLiveEvent<T extends LiveTopic>(topic: T, data: unknown): void {
  if (!store.counts.get(topic)) return;
  const previous = liveTopicValue(topic);
  const next = applyLiveEvent(topic, previous, data);
  if (next === previous) return;
  if (next === null) delete store.values[topic];
  else (store.values as Record<LiveTopic, unknown>)[topic] = next;
  emit();
}

export function liveLink(): LiveLink {
  return store.link;
}

export function setLiveLink(link: LiveLink): void {
  if (store.link === link) return;
  store.link = link;
  emit();
}

export function watchLiveLink(onChange: () => void): () => void {
  store.listeners.add(onChange);
  return () => {
    store.listeners.delete(onChange);
  };
}
