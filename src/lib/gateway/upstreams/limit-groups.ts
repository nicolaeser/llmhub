import {
  ANTIGRAVITY_FAMILIES,
  ANTIGRAVITY_HIDDEN_MODELS,
  antigravityFamily,
} from "@/lib/gateway/upstreams/antigravity-models";
import type {
  AntigravityFamily,
  LimitGroup,
  LimitGroupMember,
  LimitSummary,
  LimitWindow,
  SubscriptionLimits,
} from "@/types/providers";

const FULL_PERCENT = 100;
const SUMMARY_SIZE = 3;

type GroupHead = Pick<LimitGroup, "id" | "scoped" | "family" | "label">;

function liveMember(window: LimitWindow, now: number): LimitGroupMember {
  const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  const renewed = Number.isFinite(reset) && reset <= now;
  return {
    scope: window.scope,
    label: window.label || window.scope,
    usedPercent: renewed ? 0 : window.usedPercent,
    resetsAt: renewed ? null : window.resetsAt,
    limitReached: !renewed && (window.limitReached || window.usedPercent >= FULL_PERCENT),
  };
}

function resetTime(item: { resetsAt: string | null }): number {
  const at = item.resetsAt ? Date.parse(item.resetsAt) : NaN;
  return Number.isFinite(at) ? at : -Infinity;
}

function tighter(a: LimitGroupMember, b: LimitGroupMember): boolean {
  if (a.limitReached !== b.limitReached) return a.limitReached;
  if (a.usedPercent !== b.usedPercent) return a.usedPercent > b.usedPercent;
  return resetTime(a) > resetTime(b);
}

function sameQuota(a: LimitGroupMember, b: LimitGroupMember): boolean {
  return a.usedPercent === b.usedPercent && a.resetsAt === b.resetsAt;
}

function groupOf(head: GroupHead, windows: LimitWindow[], now: number): LimitGroup {
  const members = windows.map((window) => liveMember(window, now));
  const tightest = members.reduce((top, member) => (tighter(member, top) ? member : top));
  return {
    ...head,
    windowSeconds: Math.max(...windows.map((window) => window.windowSeconds)),
    members,
    usedPercent: tightest.usedPercent,
    resetsAt: tightest.resetsAt,
    limitReached: tightest.limitReached,
    exhausted: members.every((member) => member.limitReached),
    uniform: members.every((member) => sameQuota(member, tightest)),
  };
}

function byLength(a: LimitWindow, b: LimitWindow): number {
  return a.windowSeconds - b.windowSeconds;
}

function quotaBuckets(windows: LimitWindow[], now: number): LimitWindow[][] {
  const buckets = new Map<string, LimitWindow[]>();
  for (const window of windows) {
    const member = liveMember(window, now);
    const key = `${member.usedPercent}|${member.resetsAt ?? ""}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(window);
    else buckets.set(key, [window]);
  }
  return [...buckets.values()];
}

function familyGroups(family: AntigravityFamily, windows: LimitWindow[], now: number): LimitGroup[] {
  if (!windows.length) return [];
  if (family !== "other") {
    return [groupOf({ id: `family:${family}`, scoped: true, family, label: "" }, windows, now)];
  }
  return quotaBuckets(windows, now).map((bucket) => {
    const [first] = bucket;
    const single = bucket.length === 1;
    return groupOf(
      {
        id: `other:${first!.scope}`,
        scoped: true,
        family: single ? null : family,
        label: single ? first!.label || first!.scope : "",
      },
      bucket,
      now,
    );
  });
}

function antigravityGroups(windows: LimitWindow[], now: number): LimitGroup[] {
  const visible = windows.filter((window) => !ANTIGRAVITY_HIDDEN_MODELS.has(window.scope));
  return ANTIGRAVITY_FAMILIES.flatMap((family) =>
    familyGroups(
      family,
      visible.filter((window) => antigravityFamily(window.scope) === family),
      now,
    ),
  );
}

function windowGroups(windows: LimitWindow[], now: number): LimitGroup[] {
  return windows.map((window, index) => {
    const id = `scope:${window.scope}:${window.windowSeconds}:${index}`;
    return groupOf({ id, scoped: true, family: null, label: window.label || window.scope }, [window], now);
  });
}

export function limitGroups(kind: string, limits: SubscriptionLimits | null, now = Date.now()): LimitGroup[] {
  if (!limits) return [];
  const plan = limits.windows
    .filter((window) => !window.scope)
    .sort(byLength)
    .map((window, index) =>
      groupOf({ id: `plan:${window.windowSeconds}:${index}`, scoped: false, family: null, label: "" }, [window], now),
    );
  const scoped = limits.windows.filter((window) => window.scope);
  const grouped = kind === "antigravity" ? antigravityGroups(scoped, now) : windowGroups(scoped.sort(byLength), now);
  return [...plan, ...grouped];
}

function pressureOrder(a: LimitGroup, b: LimitGroup): number {
  if (a.limitReached !== b.limitReached) return a.limitReached ? -1 : 1;
  return b.usedPercent - a.usedPercent;
}

export function summaryGroups(groups: LimitGroup[], max = SUMMARY_SIZE): LimitSummary {
  const plan = groups.filter((group) => !group.scoped).slice(0, max);
  const scoped = groups
    .filter((group) => group.scoped)
    .sort(pressureOrder)
    .slice(0, Math.max(0, max - plan.length));
  const shown = [...plan, ...scoped];
  return { groups: shown, more: groups.length - shown.length };
}
