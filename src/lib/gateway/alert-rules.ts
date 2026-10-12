import type { Enterprise, SpendAnomalyRule } from "@/types/gateway";

export const DEFAULT_SPEND_ANOMALY_FACTOR = 3;
export const DEFAULT_SPEND_ANOMALY_MIN_COST = 5;
export const DEFAULT_KEY_EXPIRY_WARNING_DAYS = 7;
export const SPEND_ANOMALY_LOOKBACK_DAYS = 7;
export const SPEND_ANOMALY_COOLDOWN_MS = 60 * 60 * 1000;
export const PII_ALERT_COOLDOWN_MS = 15 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export function anomalyFactor(value: number): number {
  return value > 0 ? Math.max(1, value) : 0;
}

export function spendAnomalyRule(enterprise: Enterprise): SpendAnomalyRule {
  return {
    factor: anomalyFactor(enterprise.spend_anomaly_factor ?? DEFAULT_SPEND_ANOMALY_FACTOR),
    minCost: Math.max(0, enterprise.spend_anomaly_min_cost ?? DEFAULT_SPEND_ANOMALY_MIN_COST),
  };
}

export function anomalyLookbackDays(spendRetentionDays: number): number {
  if (spendRetentionDays <= 0) return SPEND_ANOMALY_LOOKBACK_DAYS;
  return Math.max(0, Math.min(SPEND_ANOMALY_LOOKBACK_DAYS, Math.floor(spendRetentionDays) - 1));
}

export function recentHour(now: Date): { gte: Date; lte: Date } {
  return { gte: new Date(now.getTime() - HOUR_MS), lte: now };
}

export function sameHourWindows(now: Date, days: number): { gte: Date; lt: Date }[] {
  return Array.from({ length: days }, (_, i) => {
    const end = now.getTime() - (i + 1) * DAY_MS;
    return { gte: new Date(end - HOUR_MS), lt: new Date(end) };
  });
}

export function historyDays(createdAt: Date, now: Date, lookbackDays: number): number {
  return Math.max(0, Math.min(lookbackDays, Math.floor((now.getTime() - createdAt.getTime()) / DAY_MS)));
}

export function isSpendAnomaly(spend: number, usual: number, rule: SpendAnomalyRule): boolean {
  return rule.factor > 0 && spend >= rule.minCost && spend >= rule.factor * usual;
}

export function nextAnomalyState(
  previous: Record<string, string>,
  anomalous: string[],
  now: Date,
): { state: Record<string, string>; fire: string[] } {
  const state: Record<string, string> = {};
  const fire: string[] = [];
  for (const id of anomalous) {
    if (previous[id]) {
      state[id] = previous[id];
      continue;
    }
    state[id] = now.toISOString();
    fire.push(id);
  }
  for (const [id, at] of Object.entries(previous)) {
    if (id in state) continue;
    if (now.getTime() - Date.parse(at) < SPEND_ANOMALY_COOLDOWN_MS) state[id] = at;
  }
  return { state, fire };
}

export function expiryWindow(now: Date, days: number): { gt: Date; lte: Date } {
  return { gt: now, lte: new Date(now.getTime() + days * DAY_MS) };
}

export function daysUntil(at: Date, now: Date): number {
  return Math.max(1, Math.ceil((at.getTime() - now.getTime()) / DAY_MS));
}

export function sameState(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

export function claimCooldown(seen: Map<string, number>, subject: string, now: number, cooldownMs: number): boolean {
  const last = seen.get(subject);
  if (last !== undefined && now - last < cooldownMs) return false;
  for (const [id, at] of seen) {
    if (now - at >= cooldownMs) seen.delete(id);
  }
  seen.set(subject, now);
  return true;
}

export function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}
