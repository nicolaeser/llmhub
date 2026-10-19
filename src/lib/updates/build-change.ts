import type { BuildInfo, LiveLink, LiveStatus, ServerHealth, UpdaterView } from "@/types/updates";

export const DEVELOPMENT_BUILD = "development";
export const VERSION_POLL_MS = 30_000;
export const UPDATE_RECHECK_MS = 6 * 3_600_000;
export const FOCUS_CHECK_GAP_MS = 5_000;
export const LIVE_URL = "/internal-api/live";
export const LIVE_STALE_MS = 35_000;
export const LIVE_WATCHDOG_MS = 5_000;
export const UPDATING_GRACE_MS = 15 * 60_000;

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

export function liveStatusOf(json: unknown): LiveStatus | null {
  if (!json || typeof json !== "object") return null;
  const record = json as Record<string, unknown>;
  const build = buildInfoOf(record.build);
  if (!build || typeof record.updating !== "boolean") return null;
  if (typeof record.canRead !== "boolean" || typeof record.canManage !== "boolean") return null;
  const updater = record.updater && typeof record.updater === "object" ? (record.updater as UpdaterView) : null;
  return { build, updater, updating: record.updating, canRead: record.canRead, canManage: record.canManage };
}

export function healthOf(input: {
  link: LiveLink;
  updating: boolean;
  reachable: boolean | null;
  lostAt: number | null;
  now: number;
}): ServerHealth {
  if (input.link === "open") return input.updating ? "updating" : "live";
  if (input.lostAt === null) return "connecting";
  if (input.updating && input.now - input.lostAt < UPDATING_GRACE_MS) return "updating";
  return input.reachable === false ? "down" : "reconnecting";
}
