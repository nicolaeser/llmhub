export const UPDATE_PHASES = ["checking", "pulling", "recreating", "verifying", "rolling_back"] as const;

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
