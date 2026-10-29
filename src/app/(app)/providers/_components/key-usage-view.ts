import { windowStart } from "@/lib/providers/key-usage-shares";
import type { AccountKeyUsage, LimitGroup, WindowUsage } from "@/types/providers";

export const KEY_SHADES = [1, 0.72, 0.5, 0.34, 0.22] as const;
export const OTHER_KEYS = "other";
export const OUTSIDE_HUB = "outside";

const STALE_GRACE_MS = 5 * 60_000;
const VISIBLE_PERCENT = 0.05;

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

export function barSegments(window: WindowView, ranks: Map<string, number>): BarSegment[] {
  const ranked: BarSegment[] = [];
  const rest: KeySlice[] = [];
  for (const slice of window.slices) {
    const shade = keyShade(ranks.get(slice.keyId) ?? KEY_SHADES.length);
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
