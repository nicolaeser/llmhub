import type { UpdaterState, UpdaterView } from "@/types/updates";

export const UPDATE_PHASES = ["checking", "pulling", "recreating", "verifying", "rolling_back"] as const;

const RUN_STEPS = ["checking", "pulling", "recreating", "verifying"] as const;
const ROLLBACK_STEPS = ["checking", "pulling", "rolling_back"] as const;
const INSTALLED_FOR_MS = 15 * 60_000;

export type UpdatePhase = (typeof UPDATE_PHASES)[number];
export type StepState = "done" | "active" | "waiting";
export type UpdaterSummary = "offline" | "requested" | "checking" | "running" | "recovery" | "failed" | "rolled_back" | "installed" | "pinned" | "available" | "current";

export function elapsedMilliseconds(start: string, end: string | number): number {
  const duration = (typeof end === "number" ? end : Date.parse(end)) - Date.parse(start);
  return Number.isFinite(duration) ? Math.max(0, duration) : 0;
}

export function recentUpdateRuns<T extends { id: string; finishedAt: string }>(history?: T[] | null): T[] {
  return [...(history ?? [])]
    .sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt))
    .filter((run, index, runs) => runs.findIndex((candidate) => candidate.id === run.id) === index)
    .slice(0, 5);
}

export function downloadView(download: {
  downloadedBytes: number;
  totalBytes: number | null;
  layersCompleted: number;
  layersTotal: number;
}) {
  const downloadedBytes = Number.isFinite(download.downloadedBytes) ? Math.max(0, download.downloadedBytes) : 0;
  const totalBytes = download.totalBytes !== null && Number.isFinite(download.totalBytes)
    && download.totalBytes > 0 && download.totalBytes >= downloadedBytes ? download.totalBytes : null;
  const layersTotal = Number.isFinite(download.layersTotal) ? Math.max(0, Math.floor(download.layersTotal)) : 0;
  const layersCompleted = Number.isFinite(download.layersCompleted)
    ? Math.min(layersTotal, Math.max(0, Math.floor(download.layersCompleted))) : 0;
  return { downloadedBytes, totalBytes, layersCompleted, layersTotal };
}

function percentOf(done: number, total: number): number {
  return Math.min(100, Math.max(0, Math.floor((done / total) * 100)));
}

export function downloadPercent(download: ReturnType<typeof downloadView>): number | null {
  if (download.totalBytes !== null) return percentOf(download.downloadedBytes, download.totalBytes);
  if (download.layersTotal > 0) return percentOf(download.layersCompleted, download.layersTotal);
  return null;
}

export function updaterActive(updater: Pick<UpdaterView, "state">): boolean {
  return updater.state !== "idle" && updater.state !== "failed";
}

export function phasePercent(updater: Pick<UpdaterView, "state" | "progress">): number | null {
  const progress = updaterActive(updater) ? updater.progress : null;
  if (!progress) return null;
  if (updater.state === "pulling") return progress.download ? downloadPercent(downloadView(progress.download)) : null;
  if ((updater.state === "recreating" || updater.state === "verifying") && progress.total > 0) {
    return percentOf(progress.completed, progress.total);
  }
  return null;
}

export function runSteps(state: UpdaterState): { phase: UpdatePhase; state: StepState }[] {
  const steps: readonly UpdatePhase[] = state === "rolling_back" ? ROLLBACK_STEPS : RUN_STEPS;
  const current = steps.indexOf(state as UpdatePhase);
  return steps.map((phase, index) => ({
    phase,
    state: current < 0 || index > current ? "waiting" : index < current ? "done" : "active",
  }));
}

export function updaterSummary(
  updater: Pick<UpdaterView, "connected" | "state" | "progress" | "pending" | "pinned" | "available" | "lastResult">,
  now: number,
): UpdaterSummary {
  if (!updater.connected) return "offline";
  if (updater.progress?.startup === "manual_recovery" || updater.progress?.startup === "migration_failed") return "recovery";
  if (updater.state === "checking" && !updater.progress) return "checking";
  if (updaterActive(updater)) return "running";
  if (updater.pending) return "requested";
  const result = updater.lastResult;
  if (updater.state === "failed") return result?.outcome === "rolled_back" ? "rolled_back" : "failed";
  if (result?.action === "update" && result.outcome === "updated" && elapsedMilliseconds(result.at, now) < INSTALLED_FOR_MS) {
    return "installed";
  }
  if (updater.pinned) return "pinned";
  return updater.available ? "available" : "current";
}

export function durationParts(milliseconds: number): { minutes: number; seconds: number } {
  const total = Math.max(0, Math.round(milliseconds / 1_000));
  return { minutes: Math.floor(total / 60), seconds: total % 60 };
}

export function stopwatch(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}
