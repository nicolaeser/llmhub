import type { LimitRefreshOutcomes, LimitSnapshot } from "@/types/providers";

const UNSEEN_VERSION = -1;

export type AwaitedRefreshes = Record<string, number>;

export type RefreshNotice = { recent: number; blocked: number; capped: number; failed: number };

export function startedRefresh(running: string[], id: string): string[] {
  return [...running, id];
}

export function finishedRefresh(running: string[], id: string): string[] {
  const index = running.indexOf(id);
  return index < 0 ? running : running.filter((_, position) => position !== index);
}

export function awaitedRefreshes(outcomes: LimitRefreshOutcomes | undefined, items: LimitSnapshot[]): AwaitedRefreshes {
  const versions = new Map(items.map((item) => [item.id, item.version]));
  return Object.fromEntries(
    Object.entries(outcomes ?? {})
      .filter(([, outcome]) => outcome === "pending")
      .map(([id]) => [id, versions.get(id) ?? UNSEEN_VERSION]),
  );
}

export function stillAwaited(awaited: AwaitedRefreshes, items: Record<string, LimitSnapshot>): string[] {
  return Object.keys(awaited).filter((id) => (items[id]?.version ?? UNSEEN_VERSION) <= awaited[id]);
}

export function refreshNotice(outcomes: LimitRefreshOutcomes | undefined): RefreshNotice | null {
  const notice: RefreshNotice = { recent: 0, blocked: 0, capped: 0, failed: 0 };
  for (const outcome of Object.values(outcomes ?? {})) {
    if (outcome !== "refreshed" && outcome !== "pending") notice[outcome] += 1;
  }
  return notice.recent + notice.blocked + notice.capped + notice.failed > 0 ? notice : null;
}
