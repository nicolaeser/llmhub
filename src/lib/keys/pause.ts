import type { HeldPause, PauseScope, PauseState } from "@/types/structure";

export const PAUSE_HOURS = [0, 1, 24, 168] as const;

export const MAX_PAUSE_HOURS = 8760;

export type KeyState = "active" | "paused" | "blocked";

type PauseRow = { paused: boolean; pausedUntil: Date | null };

export function pauseActive(paused: boolean, until: Date | null, now: Date): boolean {
  return paused && (until === null || until > now);
}

export function pauseEnd(hours: number, now: Date): Date | null {
  return hours > 0 ? new Date(now.getTime() + hours * 3_600_000) : null;
}

export function pauseView(row: PauseRow, now: Date): PauseState {
  const paused = pauseActive(row.paused, row.pausedUntil, now);
  return { paused, pausedUntil: paused ? (row.pausedUntil?.toISOString() ?? "") : "" };
}

export function pauseSnapshot(row: PauseRow, now = new Date()): { paused: boolean; pausedUntil: string | null } {
  const view = pauseView(row, now);
  return { paused: view.paused, pausedUntil: view.pausedUntil || null };
}

export function isPaused(state: PauseState, now: Date): boolean {
  return pauseActive(state.paused, state.pausedUntil ? new Date(state.pausedUntil) : null, now);
}

export function heldPause(scope: PauseScope, state: PauseState | null | undefined, now: Date): HeldPause | null {
  return state && isPaused(state, now) ? { scope, until: state.pausedUntil } : null;
}

export function rowPause(scope: PauseScope, row: PauseRow | null | undefined, now: Date): HeldPause | null {
  return row ? heldPause(scope, pauseView(row, now), now) : null;
}

export function stillHeld(pause: HeldPause | null | undefined, now: Date): HeldPause | null {
  return pause ? heldPause(pause.scope, { paused: true, pausedUntil: pause.until }, now) : null;
}

function outlasts(next: HeldPause, current: HeldPause): boolean {
  if (!current.until) return false;
  if (!next.until) return true;
  return Date.parse(next.until) > Date.parse(current.until);
}

export function longestPause(pauses: readonly (HeldPause | null | undefined)[]): HeldPause | null {
  let longest: HeldPause | null = null;
  for (const pause of pauses) {
    if (pause && (!longest || outlasts(pause, longest))) longest = pause;
  }
  return longest;
}

export function keyPause(key: PauseState, held: HeldPause | null | undefined, now: Date): HeldPause | null {
  return longestPause([heldPause("key", key, now), stillHeld(held, now)]);
}

export function keyState(key: PauseState & { blocked: boolean }, now: Date, held?: HeldPause | null): KeyState {
  if (key.blocked) return "blocked";
  return keyPause(key, held, now) ? "paused" : "active";
}
