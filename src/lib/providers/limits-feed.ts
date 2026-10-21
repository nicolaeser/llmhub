import "server-only";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { limitVersions, readLimitSnapshots } from "@/lib/gateway/upstreams/limit-store";
import type { LiveFeed, LiveLimitsEvent } from "@/types/live";
import type { LimitSnapshot } from "@/types/providers";

export const LIMITS_POLL_LIVE_MS = 5_000;

type LimitsState = { at: number; versions: Map<string, number>; items: Map<string, LimitSnapshot> };

function changedIds(versions: Map<string, number>, previous: LimitsState | null): string[] {
  return [...versions].filter(([id, version]) => previous?.versions.get(id) !== version).map(([id]) => id);
}

export const LIMITS_FEED: LiveFeed<LimitsState> = {
  topic: "limits",
  permission: PERMISSIONS.PROVIDERS_READ,
  platformOnly: true,
  pollMs: LIMITS_POLL_LIVE_MS,
  minGapMs: 1_000,
  scopeKey: () => "all",
  async load(_scope, previous) {
    const versions = await limitVersions();
    const changed = changedIds(versions, previous);
    const gone = previous ? [...previous.versions.keys()].filter((id) => !versions.has(id)) : [];
    if (previous && !changed.length && !gone.length) return previous;
    const items = new Map(previous?.items);
    for (const id of gone) items.delete(id);
    for (const item of await readLimitSnapshots(changed)) items.set(item.id, item);
    return { at: Date.now(), versions, items };
  },
  full(state): LiveLimitsEvent {
    return { at: state.at, full: true, items: [...state.items.values()], removed: [] };
  },
  change(previous, next): LiveLimitsEvent | null {
    if (previous === next) return null;
    const items = [...next.items.values()].filter((item) => previous.items.get(item.id)?.version !== item.version);
    const removed = [...previous.items.keys()].filter((id) => !next.items.has(id));
    return items.length || removed.length ? { at: next.at, full: false, items, removed } : null;
  },
};
