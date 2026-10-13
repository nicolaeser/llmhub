import type { BuildInfo } from "@/types/updates";

export const DEVELOPMENT_BUILD = "development";
export const VERSION_POLL_MS = 30_000;
export const UPDATE_RECHECK_MS = 6 * 3_600_000;
export const FOCUS_CHECK_GAP_MS = 5_000;

export function buildInfoOf(json: unknown): BuildInfo | null {
  if (!json || typeof json !== "object") return null;
  const { version, startedAt } = json as Record<string, unknown>;
  if (typeof version !== "string" || !version.trim() || typeof startedAt !== "string") return null;
  return { version, startedAt };
}

export function reloadRequired(loaded: string, served: string | null): boolean {
  if (!served || loaded === DEVELOPMENT_BUILD || served === DEVELOPMENT_BUILD) return false;
  return served !== loaded;
}

export function checkDue(lastAt: number | null, now: number, interval: number): boolean {
  return lastAt === null || now - lastAt >= interval;
}
