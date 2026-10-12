import type { LimitWindow, SubscriptionLimits } from "@/types/providers";

const FULL_PERCENT = 100;
const UNKNOWN_PRESSURE = 50;

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function applies(window: LimitWindow, model: string): boolean {
  if (!window.scope) return true;
  const scope = normalized(window.scope);
  return scope.length > 0 && normalized(model).includes(scope);
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

export function earliestRecovery(limits: SubscriptionLimits | null, now = Date.now()): number | null {
  if (!limits) return null;
  const resets = limits.windows
    .filter((window) => !window.scope && (window.limitReached || window.usedPercent >= FULL_PERCENT))
    .map((window) => (window.resetsAt ? Date.parse(window.resetsAt) : NaN))
    .filter((time) => Number.isFinite(time) && time > now);
  return resets.length ? Math.min(...resets) : null;
}
