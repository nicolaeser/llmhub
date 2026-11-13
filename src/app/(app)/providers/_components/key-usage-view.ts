import { windowStart } from "@/lib/providers/key-usage-shares";
import type { AccountKeyUsage, LimitGroup, WindowUsage } from "@/types/providers";

export const KEY_SHADES = [1, 0.72, 0.5, 0.34, 0.22] as const;
export const OTHER_KEYS = "other";
export const OUTSIDE_HUB = "outside";
export const FREE_PART = "free";

const STALE_GRACE_MS = 5 * 60_000;
const VISIBLE_PERCENT = 0.05;
const FULL_PERCENT = 100;
const MIN_SPAN_PERCENT = 2;

export type KeySlice = { keyId: string; percent: number; share: number; requests: number };

export type WindowView = { group: LimitGroup; usage: WindowUsage | null; slices: KeySlice[] };

export type KeyRow = {
  keyId: string;
  rank: number;
  peak: number;
  requests: number;
  byWindow: Record<string, KeySlice>;
};

export type AccountUsage = { windows: WindowView[]; keys: KeyRow[]; peak: number; requests: number };

export type SegmentKind = "key" | "other" | "outside";

export type BarSegment = { id: string; kind: SegmentKind; keyIds: string[]; percent: number; shade: number };

export type BarSpan = { start: number; size: number };

export type BarPart = BarSpan & { id: string; segment: BarSegment | null; percent: number };

function currentUsage(group: LimitGroup, usage: WindowUsage | undefined, now: number): WindowUsage | null {
  if (!usage) return null;
  const start = windowStart(group, now);
  if (start !== null && start > Date.parse(usage.since) + STALE_GRACE_MS) return null;
  return usage;
}

export function accountUsage(groups: LimitGroup[], usage: AccountKeyUsage | undefined, now: number): AccountUsage {
  const byGroup = new Map(usage?.windows.map((window) => [window.groupId, window]));
  const windows = groups.map((group) => {
    const current = currentUsage(group, byGroup.get(group.id), now);
    const slices = (current?.keys ?? []).map((key) => ({
      keyId: key.keyId,
      percent: group.usedPercent * key.share,
      share: key.share,
      requests: key.requests,
    }));
    return { group, usage: current, slices };
  });
  const rows = new Map<string, KeyRow>();
  for (const window of windows) {
    for (const slice of window.slices) {
      const row = rows.get(slice.keyId) ?? { keyId: slice.keyId, rank: 0, peak: 0, requests: 0, byWindow: {} };
      row.peak = Math.max(row.peak, slice.percent);
      row.requests = Math.max(row.requests, slice.requests);
      row.byWindow[window.group.id] = slice;
      rows.set(slice.keyId, row);
    }
  }
  const keys = [...rows.values()]
    .sort((a, b) => b.peak - a.peak || b.requests - a.requests || a.keyId.localeCompare(b.keyId))
    .map((row, rank) => ({ ...row, rank }));
  return {
    windows,
    keys,
    peak: Math.max(0, ...groups.map((group) => group.usedPercent)),
    requests: Math.max(0, ...windows.map((window) => window.usage?.requests ?? 0)),
  };
}

export function keyShade(rank: number): number | null {
  return KEY_SHADES[rank] ?? null;
}

export function keyRanks(usage: AccountUsage): Map<string, number> {
  return new Map(usage.keys.map((key) => [key.keyId, key.rank]));
}

export function barSegments(window: WindowView, ranks: Map<string, number>, named: number = KEY_SHADES.length): BarSegment[] {
  const ranked: BarSegment[] = [];
  const rest: KeySlice[] = [];
  for (const slice of window.slices) {
    const rank = ranks.get(slice.keyId) ?? KEY_SHADES.length;
    const shade = rank < named ? keyShade(rank) : null;
    if (shade === null) rest.push(slice);
    else ranked.push({ id: slice.keyId, kind: "key", keyIds: [slice.keyId], percent: slice.percent, shade });
  }
  ranked.sort((a, b) => (ranks.get(a.id) ?? 0) - (ranks.get(b.id) ?? 0));
  const restPercent = rest.reduce((sum, slice) => sum + slice.percent, 0);
  const attributed = window.slices.reduce((sum, slice) => sum + slice.percent, 0);
  const outside = window.group.usedPercent - attributed;
  const segments: BarSegment[] = [
    ...ranked,
    { id: OTHER_KEYS, kind: "other", keyIds: rest.map((slice) => slice.keyId), percent: restPercent, shade: 0.5 },
    { id: OUTSIDE_HUB, kind: "outside", keyIds: [], percent: outside, shade: 0.22 },
  ];
  return segments.filter((segment) => segment.percent >= VISIBLE_PERCENT);
}

function windowRanks(window: WindowView): Map<string, number> {
  const ordered = [...window.slices].sort(
    (a, b) => b.percent - a.percent || b.requests - a.requests || a.keyId.localeCompare(b.keyId),
  );
  return new Map(ordered.map((slice, rank) => [slice.keyId, rank]));
}

export function groupSegments(usage: AccountUsage, groupId: string, named: number): BarSegment[] {
  const window = usage.windows.find((item) => item.group.id === groupId);
  if (!window?.slices.length) return [];
  return barSegments(window, windowRanks(window), named);
}

export function barSpans(percents: number[]): BarSpan[] {
  const values = percents.map((value) => (Number.isFinite(value) && value > 0 ? value : 0));
  const drawn = values.filter((value) => value > 0).length;
  if (drawn === 0) return values.map(() => ({ start: 0, size: 0 }));
  const floor = Math.min(MIN_SPAN_PERCENT, FULL_PERCENT / drawn);
  const floored = new Set<number>();
  let scale = 0;
  for (;;) {
    const open = values.reduce((sum, value, index) => (floored.has(index) ? sum : sum + value), 0);
    scale = open > 0 ? (FULL_PERCENT - floor * floored.size) / open : 0;
    const short = values.flatMap((value, index) =>
      value > 0 && !floored.has(index) && value * scale < floor ? [index] : [],
    );
    if (short.length === 0) break;
    short.forEach((index) => floored.add(index));
  }
  const last = values.reduce((found, value, index) => (value > 0 ? index : found), -1);
  let start = 0;
  return values.map((value, index) => {
    const size = index === last ? FULL_PERCENT - start : floored.has(index) ? floor : value * scale;
    const span = { start, size };
    start += size;
    return span;
  });
}

export function barParts(segments: BarSegment[], used: number): BarPart[] {
  const free = Math.max(0, FULL_PERCENT - used);
  const parts = [
    ...segments.map((segment) => ({ id: segment.id, segment, percent: segment.percent })),
    ...(free > 0 ? [{ id: FREE_PART, segment: null, percent: free }] : []),
  ];
  const spans = barSpans(parts.map((part) => part.percent));
  return parts.map((part, index) => ({ ...part, ...(spans[index] ?? { start: 0, size: 0 }) }));
}
