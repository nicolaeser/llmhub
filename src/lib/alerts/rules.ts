import { CLIENT_CLOSED_STATUS } from "@/lib/gateway/errors";
import type { Enterprise } from "@/types/settings";
import type {
  AlertEmails,
  ErrorRate,
  LatencySpike,
  SpendAnomalyRule,
  StatusCount,
  TrafficAlertRule,
  TrafficScope,
  WebhookEvent,
} from "@/types/alerts";

export const DEFAULT_SPEND_ANOMALY_FACTOR = 3;
export const DEFAULT_SPEND_ANOMALY_MIN_COST = 5;
export const DEFAULT_KEY_EXPIRY_WARNING_DAYS = 7;
export const SPEND_ANOMALY_LOOKBACK_DAYS = 7;
export const SPEND_ANOMALY_COOLDOWN_MS = 60 * 60 * 1000;
export const PII_ALERT_COOLDOWN_MS = 15 * 60 * 1000;
export const DEFAULT_ERROR_RATE_PERCENT = 10;
export const DEFAULT_TRAFFIC_WINDOW_MINUTES = 15;
export const MIN_TRAFFIC_WINDOW_MINUTES = 5;
export const MAX_TRAFFIC_WINDOW_MINUTES = 240;
export const DEFAULT_TRAFFIC_MIN_REQUESTS = 50;
export const DEFAULT_LATENCY_P95_MS = 30_000;
export const DEFAULT_LATENCY_FACTOR = 3;
export const LATENCY_BASELINE_HOURS = 24;
export const LATENCY_BASELINE_TTL_MS = 15 * 60 * 1000;
export const TRAFFIC_ALERT_MODELS = 10;
export const TRAFFIC_ALERT_COOLDOWN_MS = 60 * 60 * 1000;
export const ALERT_MAIL_COOLDOWN_MS = 5 * 60 * 1000;
export const GLOBAL_TRAFFIC_SCOPE = "all";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
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

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

export function errorRateThreshold(value: number): number {
  return Math.min(100, Math.max(0, finite(value)));
}

export function trafficWindowMinutes(value: number): number {
  return Math.min(MAX_TRAFFIC_WINDOW_MINUTES, Math.max(MIN_TRAFFIC_WINDOW_MINUTES, Math.trunc(finite(value))));
}

export function trafficMinRequests(value: number): number {
  return Math.max(1, Math.trunc(finite(value)));
}

export function latencyThresholdMs(value: number): number {
  return Math.max(0, Math.trunc(finite(value)));
}

export function trafficAlertRule(enterprise: Enterprise): TrafficAlertRule {
  return {
    windowMinutes: trafficWindowMinutes(enterprise.traffic_window_minutes ?? DEFAULT_TRAFFIC_WINDOW_MINUTES),
    minRequests: trafficMinRequests(enterprise.traffic_min_requests ?? DEFAULT_TRAFFIC_MIN_REQUESTS),
    errorRatePercent: errorRateThreshold(enterprise.error_rate_threshold ?? DEFAULT_ERROR_RATE_PERCENT),
    latencyP95Ms: latencyThresholdMs(enterprise.latency_p95_ms ?? DEFAULT_LATENCY_P95_MS),
    latencyFactor: anomalyFactor(finite(enterprise.latency_factor ?? DEFAULT_LATENCY_FACTOR)),
  };
}

export function trafficWindow(now: Date, minutes: number): { gte: Date; lte: Date } {
  return { gte: new Date(now.getTime() - minutes * MINUTE_MS), lte: now };
}

export function latencyBaselineWindow(now: Date, minutes: number): { gte: Date; lt: Date } {
  const end = now.getTime() - minutes * MINUTE_MS;
  return { gte: new Date(end - LATENCY_BASELINE_HOURS * HOUR_MS), lt: new Date(end) };
}

export function isErrorStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

export function isCancelledStatus(status: number): boolean {
  return status === CLIENT_CLOSED_STATUS;
}

export function errorRate(counts: StatusCount[]): ErrorRate {
  let requests = 0;
  let errors = 0;
  for (const { status, count } of counts) {
    requests += count;
    if (isErrorStatus(status)) errors += count;
  }
  return { requests, errors, percent: requests ? (errors / requests) * 100 : 0 };
}

export function answeredRequests(counts: StatusCount[]): number {
  return counts.reduce((sum, { status, count }) => (isCancelledStatus(status) ? sum : sum + count), 0);
}

export function isErrorRateSpike(rate: ErrorRate, rule: TrafficAlertRule): boolean {
  return rule.errorRatePercent > 0 && rate.requests >= rule.minRequests && rate.percent > rule.errorRatePercent;
}

export function latencySpike(p95: number, baseline: number, rule: TrafficAlertRule): LatencySpike {
  return {
    absolute: rule.latencyP95Ms > 0 && p95 > rule.latencyP95Ms,
    relative: rule.latencyFactor > 0 && baseline > 0 && p95 > rule.latencyFactor * baseline,
  };
}

export function trafficScopes(
  rows: { model: string; status: number; count: number }[],
  limit = TRAFFIC_ALERT_MODELS,
): TrafficScope[] {
  const all = new Map<number, number>();
  const models = new Map<string, Map<number, number>>();
  for (const { model, status, count } of rows) {
    all.set(status, (all.get(status) ?? 0) + count);
    if (!model) continue;
    const counts = models.get(model) ?? new Map<number, number>();
    counts.set(status, (counts.get(status) ?? 0) + count);
    models.set(model, counts);
  }
  const list = (counts: Map<number, number>) => [...counts].map(([status, count]) => ({ status, count }));
  const total = (counts: Map<number, number>) => [...counts.values()].reduce((sum, count) => sum + count, 0);
  const top = [...models]
    .sort((a, b) => total(b[1]) - total(a[1]) || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([model, counts]) => ({ id: `model:${model}`, model, counts: list(counts) }));
  return [{ id: GLOBAL_TRAFFIC_SCOPE, model: "", counts: list(all) }, ...top];
}

export function nextIncidentState(
  previous: Record<string, string>,
  active: string[],
  now: Date,
  cooldownMs = TRAFFIC_ALERT_COOLDOWN_MS,
): { state: Record<string, string>; fire: string[] } {
  const state: Record<string, string> = {};
  const fire: string[] = [];
  for (const id of active) {
    if (!previous[id]) fire.push(id);
    state[id] = now.toISOString();
  }
  for (const [id, lastSeen] of Object.entries(previous)) {
    if (id in state) continue;
    if (now.getTime() - Date.parse(lastSeen) < cooldownMs) state[id] = lastSeen;
  }
  return { state, fire };
}

function scopeName(model: string): string {
  return model ? `model ${model}` : "all models";
}

function decimal(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

export function errorRateMessage(model: string, rate: ErrorRate, rule: TrafficAlertRule): string {
  return `${scopeName(model)}: error rate ${rate.percent.toFixed(1)}% (${rate.errors} of ${rate.requests} requests were 5xx or 429) over the last ${rule.windowMinutes} minutes; threshold ${decimal(rule.errorRatePercent)}%`;
}

export function latencyMessage(
  model: string,
  latency: { p95: number; baseline: number; requests: number },
  spike: LatencySpike,
  rule: TrafficAlertRule,
): string {
  const reasons = [
    ...(spike.absolute ? [`threshold ${seconds(rule.latencyP95Ms)}`] : []),
    ...(spike.relative
      ? [
          `${decimal(latency.p95 / latency.baseline)}x the p95 of ${seconds(latency.baseline)} over the previous ${LATENCY_BASELINE_HOURS} hours (factor ${decimal(rule.latencyFactor)})`,
        ]
      : []),
  ];
  return `${scopeName(model)}: p95 latency ${seconds(latency.p95)} over the last ${rule.windowMinutes} minutes (${latency.requests} requests); ${reasons.join(" and ")}`;
}

export function alertMailRecipients(emails: AlertEmails | undefined, event: WebhookEvent): string[] {
  return emails?.events.includes(event) ? emails.recipients : [];
}
