import type { LimitWindow, SubscriptionLimits } from "@/types/providers";

const UNIFIED_PREFIX = "anthropic-ratelimit-unified";
const OBSERVED_WINDOWS = [
  { claim: "five_hour", key: "5h", windowSeconds: 5 * 3_600 },
  { claim: "seven_day", key: "7d", windowSeconds: 7 * 86_400 },
] as const;
const UNIFIED_STATUSES = ["allowed", "allowed_warning", "rejected"] as const;
const MAX_UTILIZATION = 1.5;
const FULL_PERCENT = 100;
const SECONDS_EPOCH_LIMIT = 100_000_000_000;
const USAGE_STEP = 1;
const RESET_DRIFT_MS = 60_000;
const DECIMAL = /^\d+(?:\.\d+)?$/;

type UnifiedStatus = (typeof UNIFIED_STATUSES)[number];

function unified(headers: Headers, name: string): string {
  return headers.get(`${UNIFIED_PREFIX}-${name}`)?.trim() ?? "";
}

function unifiedStatus(value: string): UnifiedStatus | null {
  return UNIFIED_STATUSES.find((status) => status === value) ?? null;
}

function usedPercent(value: string): number | null {
  if (!DECIMAL.test(value)) return null;
  const fraction = Number(value);
  if (!Number.isFinite(fraction) || fraction > MAX_UTILIZATION) return null;
  return Math.min(FULL_PERCENT, Math.round(fraction * FULL_PERCENT * 10) / 10);
}

function resetTime(value: string): number | null {
  if (!value) return null;
  const numeric = DECIMAL.test(value);
  const at = numeric ? Number(value) : Date.parse(value);
  if (!Number.isFinite(at) || at <= 0) return null;
  return Math.round(numeric && at < SECONDS_EPOCH_LIMIT ? at * 1000 : at);
}

export function claudeHeaderWindows(headers: Headers): LimitWindow[] {
  const rejected = unifiedStatus(unified(headers, "status")) === "rejected";
  const claim = unified(headers, "representative-claim");
  const claimReset = resetTime(unified(headers, "reset"));
  const windows: LimitWindow[] = [];
  for (const spec of OBSERVED_WINDOWS) {
    const used = usedPercent(unified(headers, `${spec.key}-utilization`));
    const claimed = claim === spec.claim;
    if (used === null && !(rejected && claimed)) continue;
    const percent = used ?? FULL_PERCENT;
    const reset = resetTime(unified(headers, `${spec.key}-reset`)) ?? (claimed ? claimReset : null);
    windows.push({
      scope: "",
      usedPercent: percent,
      windowSeconds: spec.windowSeconds,
      resetsAt: reset === null ? null : new Date(reset).toISOString(),
      limitReached:
        unifiedStatus(unified(headers, `${spec.key}-status`)) === "rejected" ||
        (rejected && claimed) ||
        percent >= FULL_PERCENT,
    });
  }
  return windows;
}

export function claudeRejectionReset(headers: Headers, now: number): number | null {
  const overall = unifiedStatus(unified(headers, "status"));
  const claim = unified(headers, "representative-claim");
  const windows = OBSERVED_WINDOWS.map((spec) => ({ spec, status: unifiedStatus(unified(headers, `${spec.key}-status`)) }));
  const rejected = windows.filter((window) => window.status === "rejected");
  const anyAllowed = windows.some((window) => window.status === "allowed" || window.status === "allowed_warning");
  const unreported = !overall && windows.every((window) => window.status === null);
  const claimRejected =
    overall === "rejected" && (OBSERVED_WINDOWS.some((spec) => spec.claim === claim) || !anyAllowed);
  if (!rejected.length && !claimRejected && !unreported) return null;
  const resets = [
    ...rejected.map((window) => resetTime(unified(headers, `${window.spec.key}-reset`))),
    resetTime(unified(headers, "reset")),
  ].filter((at): at is number => at !== null && at > now);
  return resets.length ? Math.max(...resets) : null;
}

export function isObservedWindow(window: LimitWindow): boolean {
  return !window.scope;
}

function sameWindow(a: LimitWindow, b: LimitWindow): boolean {
  return a.scope === b.scope && a.windowSeconds === b.windowSeconds;
}

function resetMs(window: LimitWindow): number | null {
  const at = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  return Number.isFinite(at) ? at : null;
}

export function observedWindowsBefore(previous: LimitWindow[], fetched: LimitWindow[], now: number): LimitWindow[] {
  return previous.filter((window) => {
    if (!isObservedWindow(window) || fetched.some((item) => sameWindow(item, window))) return false;
    const reset = resetMs(window);
    return reset === null || reset > now;
  });
}

function withKnownReset(next: LimitWindow, prior: LimitWindow, at: number): LimitWindow {
  if (next.resetsAt !== null) return next;
  const reset = resetMs(prior);
  return reset !== null && reset > at ? { ...next, resetsAt: prior.resetsAt } : next;
}

export function withObservedWindows(limits: SubscriptionLimits, observed: LimitWindow[], at: number): SubscriptionLimits {
  const pending = [...observed];
  const windows = limits.windows.map((window) => {
    const index = isObservedWindow(window) ? pending.findIndex((item) => sameWindow(item, window)) : -1;
    if (index < 0) return window;
    const [next] = pending.splice(index, 1);
    return withKnownReset(next!, window, at);
  });
  return { ...limits, windows: [...pending, ...windows], observedAt: new Date(at).toISOString() };
}

export function observedFlipped(before: LimitWindow[], after: LimitWindow[]): boolean {
  return after.some((window) => {
    const prior = before.find((item) => sameWindow(item, window));
    return !prior || prior.limitReached !== window.limitReached;
  });
}

function resetMoved(a: LimitWindow, b: LimitWindow): boolean {
  const left = resetMs(a);
  const right = resetMs(b);
  if (left === null || right === null) return left !== right;
  return Math.abs(left - right) > RESET_DRIFT_MS;
}

export function observedChanged(before: LimitWindow[], after: LimitWindow[]): boolean {
  if (observedFlipped(before, after)) return true;
  return after.some((window) => {
    const prior = before.find((item) => sameWindow(item, window));
    return !prior || Math.abs(prior.usedPercent - window.usedPercent) >= USAGE_STEP || resetMoved(prior, window);
  });
}

function timeOf(value: string | undefined): number {
  const at = value ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : -Infinity;
}

export function observedTime(limits: SubscriptionLimits): number {
  return timeOf(limits.observedAt);
}

export function limitsUpdatedAt(limits: SubscriptionLimits): number {
  return Math.max(timeOf(limits.fetchedAt), observedTime(limits));
}

export function updatedFromTraffic(limits: SubscriptionLimits): boolean {
  return observedTime(limits) > timeOf(limits.fetchedAt);
}

export function newestLimits(current: SubscriptionLimits, incoming: SubscriptionLimits): SubscriptionLimits {
  const base = timeOf(incoming.fetchedAt) >= timeOf(current.fetchedAt) ? incoming : current;
  const other = base === incoming ? current : incoming;
  const observed = observedTime(other);
  if (observed <= limitsUpdatedAt(base)) return base;
  return withObservedWindows(base, other.windows.filter(isObservedWindow), observed);
}
