import type { LimitWindow, SubscriptionLimits } from "@/types/providers";

const FULL_PERCENT = 100;
const UNKNOWN_PRESSURE = 50;
export const KICKOFF_RESET_GRACE_MS = 30_000;
export const KICKOFF_IDLE_RETRY_MS = 60 * 60_000;

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function scopeApplies(windowScope: string, model: string): boolean {
  if (!windowScope) return true;
  const scope = normalized(windowScope);
  return scope.length > 0 && normalized(model).includes(scope);
}

function applies(window: LimitWindow, model: string): boolean {
  return scopeApplies(window.scope, model);
}

function liveWindows(limits: SubscriptionLimits, model: string, now: number): LimitWindow[] {
  return limits.windows
    .filter((window) => applies(window, model))
    .map((window) => {
      const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
      if (Number.isFinite(resetsAt) && resetsAt <= now) return { ...window, usedPercent: 0, limitReached: false };
      return window;
    });
}

export function quotaExhausted(limits: SubscriptionLimits | null, model: string, now = Date.now()): boolean {
  if (!limits) return false;
  return liveWindows(limits, model, now).some((window) => window.limitReached || window.usedPercent >= FULL_PERCENT);
}

export function hasExhaustedQuota(limits: SubscriptionLimits | null, now = Date.now()): boolean {
  if (!limits) return false;
  return limits.windows.some((window) => {
    const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
    if (Number.isFinite(resetsAt) && resetsAt <= now) return false;
    return window.limitReached || window.usedPercent >= FULL_PERCENT;
  });
}

export function quotaPressure(limits: SubscriptionLimits | null, model: string, now = Date.now()): number {
  if (!limits) return UNKNOWN_PRESSURE;
  const windows = liveWindows(limits, model, now);
  if (!windows.length) return UNKNOWN_PRESSURE;
  return Math.max(...windows.map((window) => window.usedPercent));
}

export function quotaBottleneckReset(limits: SubscriptionLimits | null, model: string, now = Date.now()): number {
  if (!limits) return Infinity;
  const windows = liveWindows(limits, model, now).filter((window) => window.resetsAt);
  if (!windows.length) return Infinity;
  const top = Math.max(...windows.map((window) => window.usedPercent));
  const resets = windows
    .filter((window) => window.usedPercent === top)
    .map((window) => Date.parse(window.resetsAt!))
    .filter((time) => Number.isFinite(time));
  return resets.length ? Math.min(...resets) : Infinity;
}

export function latestRecovery(limits: SubscriptionLimits | null, now = Date.now()): number | null {
  return modelRecoveryAt(limits, "", now);
}

export function modelRecoveryAt(limits: SubscriptionLimits | null, model: string, now = Date.now()): number | null {
  if (!limits) return null;
  const exhausted = liveWindows(limits, model, now).filter(
    (window) => window.limitReached || window.usedPercent >= FULL_PERCENT,
  );
  if (!exhausted.length) return null;
  const resets = exhausted.map((window) => (window.resetsAt ? Date.parse(window.resetsAt) : NaN));
  if (resets.some((time) => !Number.isFinite(time))) return null;
  return Math.max(...resets);
}

export function accountRecoveryAt(limits: SubscriptionLimits | null, now = Date.now()): number | null {
  const planWide = latestRecovery(limits, now);
  if (planWide !== null) return planWide;
  if (!limits) return null;
  const scopedExhausted = limits.windows.filter((window) => {
    if (!window.scope) return false;
    const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
    if (Number.isFinite(reset) && reset <= now) return false;
    return (window.limitReached || window.usedPercent >= FULL_PERCENT) && Number.isFinite(reset) && reset > now;
  });
  if (!scopedExhausted.length) return null;
  const resets = scopedExhausted.map((window) => Date.parse(window.resetsAt!));
  return Math.min(...resets);
}

export function windowKickoffDue(
  limits: SubscriptionLimits | null,
  model: string,
  lastKickoff: number | null,
  now = Date.now(),
): boolean {
  if (!limits || quotaExhausted(limits, model, now)) return false;
  return limits.windows
    .filter((window) => applies(window, model))
    .some((window) => {
      const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
      if (Number.isFinite(reset)) {
        return reset + KICKOFF_RESET_GRACE_MS <= now && (lastKickoff === null || lastKickoff < reset);
      }
      const idle = !window.scope && window.usedPercent === 0 && !window.limitReached;
      return idle && (lastKickoff === null || now - lastKickoff >= KICKOFF_IDLE_RETRY_MS);
    });
}
