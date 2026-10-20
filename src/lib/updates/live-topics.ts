import "server-only";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import type { LiveFeed, LiveTopic } from "@/types/live";
import type { SpendScope } from "@/types/structure";

export const LIVE_NOTIFY_DELAY_MS = 250;

type TopicListener = (json: string) => void;

type Channel = {
  key: string;
  feed: LiveFeed<unknown>;
  scope: SpendScope;
  listeners: Set<TopicListener>;
  waiting: Set<TopicListener>;
  state: { value: unknown } | null;
  poller: ReturnType<typeof setInterval> | null;
  timer: ReturnType<typeof setTimeout> | null;
  timerAt: number;
  running: boolean;
  again: boolean;
  lastRun: number;
};

type TopicHub = { channels: Map<string, Channel> };

const holder = globalThis as typeof globalThis & { __llmhubLiveTopics?: TopicHub };

function topicHub(): TopicHub {
  holder.__llmhubLiveTopics ??= { channels: new Map() };
  return holder.__llmhubLiveTopics;
}

async function refresh(channel: Channel): Promise<void> {
  if (channel.running) {
    channel.again = true;
    return;
  }
  channel.running = true;
  try {
    do {
      channel.again = false;
      channel.lastRun = Date.now();
      const previous = channel.state;
      const next = await channel.feed.load(channel.scope, previous ? previous.value : null);
      if (!channel.listeners.size) return;
      channel.state = { value: next };
      const delta = previous ? channel.feed.change(previous.value, next) : null;
      const waiting = [...channel.waiting];
      channel.waiting.clear();
      if (waiting.length) {
        const full = JSON.stringify(channel.feed.full(next));
        for (const listener of waiting) listener(full);
      }
      if (delta) {
        const json = JSON.stringify(delta);
        for (const listener of channel.listeners) if (!waiting.includes(listener)) listener(json);
      }
    } while (channel.again && channel.listeners.size);
  } catch (err) {
    logger.warn("live.topic_failed", { topic: channel.feed.topic, ...errorFields(err) });
  } finally {
    channel.running = false;
  }
}

function schedule(channel: Channel, delayMs: number): void {
  const at = Math.max(Date.now() + delayMs, channel.lastRun + channel.feed.minGapMs);
  if (channel.timer && channel.timerAt <= at) return;
  if (channel.timer) clearTimeout(channel.timer);
  channel.timerAt = at;
  channel.timer = setTimeout(() => {
    channel.timer = null;
    void refresh(channel);
  }, at - Date.now());
  channel.timer.unref?.();
}

function close(hub: TopicHub, channel: Channel): void {
  if (channel.poller) clearInterval(channel.poller);
  if (channel.timer) clearTimeout(channel.timer);
  channel.poller = null;
  channel.timer = null;
  hub.channels.delete(channel.key);
}

export function subscribeTopic(feed: LiveFeed<unknown>, scope: SpendScope, listener: TopicListener): () => void {
  const hub = topicHub();
  const key = `${feed.topic}|${feed.scopeKey(scope)}`;
  let channel = hub.channels.get(key);
  if (!channel) {
    channel = {
      key,
      feed,
      scope,
      listeners: new Set(),
      waiting: new Set(),
      state: null,
      poller: null,
      timer: null,
      timerAt: 0,
      running: false,
      again: false,
      lastRun: 0,
    };
    hub.channels.set(key, channel);
  }
  const current = channel;
  current.listeners.add(listener);
  if (current.state) {
    listener(JSON.stringify(current.feed.full(current.state.value)));
  } else {
    current.waiting.add(listener);
    schedule(current, 0);
  }
  if (!current.poller) {
    current.poller = setInterval(() => void refresh(current), current.feed.pollMs);
    current.poller.unref?.();
  }
  return () => {
    current.listeners.delete(listener);
    current.waiting.delete(listener);
    if (!current.listeners.size && hub.channels.get(key) === current) close(hub, current);
  };
}

export function notifyLive(topic: LiveTopic): void {
  const hub = holder.__llmhubLiveTopics;
  if (!hub) return;
  for (const channel of hub.channels.values()) {
    if (channel.feed.topic === topic) schedule(channel, LIVE_NOTIFY_DELAY_MS);
  }
}
