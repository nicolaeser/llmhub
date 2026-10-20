import type { LiveLimits, LiveRequests, LiveTopic, LiveTopicValues, UsageToday } from "@/types/live";
import type { LimitSnapshot, LimitSnapshotList } from "@/types/providers";

export const LIVE_TOPICS: readonly LiveTopic[] = ["limits", "requests", "usage"];

const MAX_TOPICS_PARAM = 200;

export function parseLiveTopics(value: string | null | undefined): LiveTopic[] {
  if (!value) return [];
  const wanted = new Set(value.slice(0, MAX_TOPICS_PARAM).split(",").map((item) => item.trim()));
  return LIVE_TOPICS.filter((topic) => wanted.has(topic));
}

export function liveUrl(base: string, topics: readonly LiveTopic[]): string {
  const list = LIVE_TOPICS.filter((topic) => topics.includes(topic));
  return list.length ? `${base}?topics=${list.join(",")}` : base;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function limitSnapshotOf(value: unknown): LimitSnapshot | null {
  const item = record(value);
  if (!item || typeof item.id !== "string" || !item.id || typeof item.error !== "string") return null;
  const version = finite(item.version);
  const limits = record(item.limits);
  if (version === null || (item.limits !== null && (!limits || !Array.isArray(limits.windows)))) return null;
  return {
    id: item.id,
    limits: limits as LimitSnapshot["limits"],
    error: item.error,
    version,
    checkedAt: text(item.checkedAt),
    nextAt: text(item.nextAt),
    retryAt: text(item.retryAt),
  };
}

function snapshots(value: unknown): LimitSnapshot[] {
  return Array.isArray(value) ? value.flatMap((item) => limitSnapshotOf(item) ?? []) : [];
}

function newer(current: LimitSnapshot | undefined, next: LimitSnapshot): boolean {
  return !current || next.version > current.version;
}

export function applyLimitsEvent(previous: LiveLimits | null, data: unknown): LiveLimits | null {
  const event = record(data);
  const at = finite(event?.at);
  if (!event || at === null) return previous;
  const full = event.full === true || !previous;
  const items: Record<string, LimitSnapshot> = full ? {} : { ...previous.items };
  const removed: Record<string, number> = { ...previous?.removed };
  for (const item of snapshots(event.items)) {
    const prior = previous?.items[item.id];
    items[item.id] = prior && !newer(prior, item) ? prior : item;
    delete removed[item.id];
  }
  if (full && previous) {
    for (const id of Object.keys(previous.items)) if (!items[id]) removed[id] = at;
  }
  for (const id of Array.isArray(event.removed) ? event.removed : []) {
    if (typeof id !== "string") continue;
    delete items[id];
    removed[id] = at;
  }
  return { at, items, removed };
}

export function liveRequestsOf(data: unknown): LiveRequests | null {
  const event = record(data);
  const at = finite(event?.at);
  if (!event || at === null) return null;
  return {
    at,
    requestId: text(event.requestId),
    requestAt: text(event.requestAt),
    auditId: text(event.auditId),
    auditAt: text(event.auditAt),
  };
}

export function usageTodayOf(data: unknown): UsageToday | null {
  const event = record(data);
  const at = finite(event?.at);
  const day = text(event?.day);
  const spend = finite(event?.spend);
  const requests = finite(event?.requests);
  const errors = finite(event?.errors);
  const tokens = finite(event?.tokens);
  if (at === null || day === null || spend === null || requests === null || errors === null || tokens === null) {
    return null;
  }
  return { at, day, spend, requests, errors, tokens };
}

export function applyLiveEvent<T extends LiveTopic>(
  topic: T,
  previous: LiveTopicValues[T] | null,
  data: unknown,
): LiveTopicValues[T] | null {
  if (record(data)?.revoked === true) return null;
  if (topic === "limits") return applyLimitsEvent(previous as LiveLimits | null, data) as LiveTopicValues[T] | null;
  if (topic === "requests") return (liveRequestsOf(data) ?? previous) as LiveTopicValues[T] | null;
  return (usageTodayOf(data) ?? previous) as LiveTopicValues[T] | null;
}

export function mergeLimits(seed: LimitSnapshotList | null, live: LiveLimits | null): Record<string, LimitSnapshot> {
  const merged: Record<string, LimitSnapshot> = {};
  for (const item of seed?.items ?? []) {
    const removedAt = live?.removed[item.id];
    if (removedAt === undefined || removedAt < (seed?.at ?? 0)) merged[item.id] = item;
  }
  for (const item of Object.values(live?.items ?? {})) {
    if (newer(merged[item.id], item)) merged[item.id] = item;
  }
  return merged;
}

export function withLimitItems(list: LimitSnapshotList, items: LimitSnapshot[]): LimitSnapshotList {
  const byId = new Map(list.items.map((item) => [item.id, item]));
  for (const item of items) if (newer(byId.get(item.id), item)) byId.set(item.id, item);
  return { at: list.at, items: [...byId.values()] };
}

export function newestOf<T extends { at: number }>(seed: T | null, live: T | null): T | null {
  if (!seed) return live;
  if (!live) return seed;
  return live.at >= seed.at ? live : seed;
}
