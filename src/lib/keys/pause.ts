export const KEY_PAUSE_HOURS = [0, 1, 24, 168] as const;

export const MAX_KEY_PAUSE_HOURS = 8760;

export type KeyState = "active" | "paused" | "blocked";

export type KeyPause = { paused: boolean; pausedUntil: string };

export function pauseActive(paused: boolean, until: Date | null, now: Date): boolean {
  return paused && (until === null || until > now);
}

export function pauseEnd(hours: number, now: Date): Date | null {
  return hours > 0 ? new Date(now.getTime() + hours * 3_600_000) : null;
}

export function isKeyPaused(key: KeyPause, now: Date): boolean {
  return pauseActive(key.paused, key.pausedUntil ? new Date(key.pausedUntil) : null, now);
}

export function keyState(key: KeyPause & { blocked: boolean }, now: Date): KeyState {
  if (key.blocked) return "blocked";
  return isKeyPaused(key, now) ? "paused" : "active";
}
