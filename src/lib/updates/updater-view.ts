import type {
  LiveStatus,
  StoredUpdaterStatus,
  UpdaterCommand,
  UpdaterDesired,
  UpdaterSnapshot,
  UpdaterState,
  UpdaterView,
} from "@/types/updates";

export const UPDATER_CONNECTED_MS = 30_000;
export const UPDATER_COMMAND_TTL_MS = 10 * 60_000;
export const UPDATER_RESTART_WINDOW_MS = 15 * 60_000;

const RESTARTING_STATES: readonly UpdaterState[] = ["pulling", "recreating", "verifying", "rolling_back"];

export function commandActive(command: UpdaterCommand | null, now: number): command is UpdaterCommand {
  if (!command) return false;
  const age = now - Date.parse(command.requestedAt);
  return age >= -UPDATER_CONNECTED_MS && age < UPDATER_COMMAND_TTL_MS;
}

export function updaterConnected(status: Pick<StoredUpdaterStatus, "seenAt"> | null, now: number): boolean {
  return Boolean(status && now - Date.parse(status.seenAt) < UPDATER_CONNECTED_MS);
}

export function isRestarting(status: Pick<StoredUpdaterStatus, "seenAt" | "state"> | null, now: number): boolean {
  return Boolean(
    status && RESTARTING_STATES.includes(status.state) && now - Date.parse(status.seenAt) < UPDATER_RESTART_WINDOW_MS,
  );
}

export function updaterView(
  status: StoredUpdaterStatus | null,
  command: UpdaterCommand | null,
  auto: boolean,
  now: number,
): UpdaterView | null {
  if (!status) return null;
  const connected = updaterConnected(status, now);
  return {
    connected,
    seenAt: connected ? null : status.seenAt,
    version: status.version,
    state: status.state,
    issue: status.issue,
    image: status.image,
    tag: status.tag,
    pinned: status.pinned,
    targets: status.targets,
    currentDigest: status.currentDigest,
    latestDigest: status.latestDigest,
    available: status.available && !status.pinned,
    checkedAt: status.checkedAt,
    lastResult: status.lastResult,
    auto,
    pending: commandActive(command, now) ? command.action : null,
  };
}

export function desiredState(auto: boolean, command: UpdaterCommand | null, now: number): UpdaterDesired {
  return {
    auto,
    command: commandActive(command, now) ? { id: command.id, action: command.action } : null,
  };
}

export function livePayload(
  snapshot: UpdaterSnapshot,
  access: { canRead: boolean; canManage: boolean },
): LiveStatus {
  return {
    build: snapshot.build,
    updater: access.canRead ? snapshot.updater : null,
    updating: snapshot.updating,
    canRead: access.canRead,
    canManage: access.canRead && access.canManage,
  };
}

export function shortDigest(digest: string | null): string {
  return digest ? digest.replace(/^sha256:/, "").slice(0, 12) : "";
}
