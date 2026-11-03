import "server-only";

import prisma from "@/lib/db/prisma";
import { fireAlert } from "@/lib/alerts/notify";
import {
  answeredRequests,
  anomalyLookbackDays,
  daysUntil,
  DEFAULT_KEY_EXPIRY_WARNING_DAYS,
  errorRate,
  errorRateMessage,
  expiryWindow,
  historyDays,
  isErrorRateSpike,
  isSpendAnomaly,
  LATENCY_BASELINE_TTL_MS,
  latencyBaselineWindow,
  latencyMessage,
  latencySpike,
  nextAnomalyState,
  nextIncidentState,
  recentHour,
  sameHourWindows,
  sameState,
  spendAnomalyRule,
  trafficAlertRule,
  trafficScopes,
  trafficWindow,
  usd,
} from "@/lib/alerts/rules";
import { getAlertState, getEnterprise, saveAlertState } from "@/lib/settings/enterprise";
import { p95Latency } from "@/lib/usage/usage-totals";
import { CLIENT_CLOSED_STATUS } from "@/lib/gateway/errors";
import { money } from "@/lib/utils/money";
import type { Prisma } from "@/generated/prisma/client";
import type { AlertStateKind, TrafficAlertRule, TrafficScope, WebhookEvent } from "@/types/alerts";

function spendBy<K extends "keyId" | "projectId">(
  rows: ({ _sum: { cost: Prisma.Decimal | null } } & Record<K, string>)[],
  field: K,
) {
  return new Map(rows.map((row) => [row[field], money(row._sum.cost ?? 0)]));
}

async function recentSpend(now: Date, minCost: number) {
  const createdAt = recentHour(now);
  const [keys, projects] = await Promise.all([
    prisma.spendEvent.groupBy({
      by: ["keyId"],
      where: { keyId: { not: "" }, createdAt },
      _sum: { cost: true },
    }),
    prisma.spendEvent.groupBy({
      by: ["projectId"],
      where: { projectId: { not: "" }, createdAt },
      _sum: { cost: true },
    }),
  ]);
  const above = (spend: Map<string, number>) => new Map([...spend].filter(([, cost]) => cost >= minCost));
  return { keys: above(spendBy(keys, "keyId")), projects: above(spendBy(projects, "projectId")) };
}

async function usualSpend(now: Date, days: number, keyIds: string[], projectIds: string[]) {
  const windows = sameHourWindows(now, days).map((createdAt) => ({ createdAt }));
  const [keys, projects] = await Promise.all([
    keyIds.length
      ? prisma.spendEvent.groupBy({
          by: ["keyId"],
          where: { keyId: { in: keyIds }, OR: windows },
          _sum: { cost: true },
        })
      : [],
    projectIds.length
      ? prisma.spendEvent.groupBy({
          by: ["projectId"],
          where: { projectId: { in: projectIds }, OR: windows },
          _sum: { cost: true },
        })
      : [],
  ]);
  return { keys: spendBy(keys, "keyId"), projects: spendBy(projects, "projectId") };
}

export async function runSpendAnomalyAlerts(now = new Date()): Promise<number> {
  const enterprise = await getEnterprise();
  const rule = spendAnomalyRule(enterprise);
  const lookback = anomalyLookbackDays(enterprise.spend_retention_days ?? 0);
  const previous = await getAlertState("spend_anomaly");
  if (!rule.factor || !lookback) {
    if (Object.keys(previous).length) await saveAlertState("spend_anomaly", {});
    return 0;
  }
  const recent = await recentSpend(now, rule.minCost);
  const keyIds = [...recent.keys.keys()];
  const projectIds = [...recent.projects.keys()];
  const [keys, projects, usual] = await Promise.all([
    keyIds.length
      ? prisma.virtualKey.findMany({
          where: { id: { in: keyIds } },
          select: { id: true, keyAlias: true, prefix: true, createdAt: true },
        })
      : [],
    projectIds.length
      ? prisma.project.findMany({
          where: { id: { in: projectIds } },
          select: { id: true, alias: true, createdAt: true },
        })
      : [],
    usualSpend(now, lookback, keyIds, projectIds),
  ]);
  const entities = [
    ...keys.map((k) => ({
      kind: "key",
      id: k.id,
      alias: k.keyAlias || k.prefix,
      createdAt: k.createdAt,
      spend: recent.keys.get(k.id) ?? 0,
      total: usual.keys.get(k.id) ?? 0,
    })),
    ...projects.map((p) => ({
      kind: "project",
      id: p.id,
      alias: p.alias,
      createdAt: p.createdAt,
      spend: recent.projects.get(p.id) ?? 0,
      total: usual.projects.get(p.id) ?? 0,
    })),
  ].flatMap((entity) => {
    const days = historyDays(entity.createdAt, now, lookback);
    if (!days) return [];
    const hourly = entity.total / days;
    if (!isSpendAnomaly(entity.spend, hourly, rule)) return [];
    return [{ ...entity, stateKey: `${entity.kind}:${entity.id}`, days, usual: hourly }];
  });
  const { state, fire } = nextAnomalyState(
    previous,
    entities.map((entity) => entity.stateKey),
    now,
  );
  let fired = 0;
  for (const entity of entities) {
    if (!fire.includes(entity.stateKey)) continue;
    await fireAlert(
      "spend_anomaly",
      `${entity.kind} ${entity.alias} spent ${usd(entity.spend)} in the last hour; the same hour averaged ${usd(entity.usual)} over the previous ${entity.days} ${entity.days === 1 ? "day" : "days"}`,
    );
    await prisma.gatewayAuditLog.create({
      data: {
        actor: "worker",
        action: "spend_anomaly",
        objectType: entity.kind,
        objectId: entity.id,
        afterJson: JSON.stringify({
          spend: entity.spend,
          usual: entity.usual,
          days: entity.days,
          factor: rule.factor,
        }),
      },
    });
    fired += 1;
  }
  if (!sameState(previous, state)) await saveAlertState("spend_anomaly", state);
  return fired;
}

export async function runKeyExpiryAlerts(now = new Date()): Promise<number> {
  const enterprise = await getEnterprise();
  const days = enterprise.key_expiry_warning_days ?? DEFAULT_KEY_EXPIRY_WARNING_DAYS;
  const previous = await getAlertState("key_expiry");
  const keys = days
    ? await prisma.virtualKey.findMany({
        where: { blocked: false, expiresAt: expiryWindow(now, days) },
        select: { id: true, keyAlias: true, prefix: true, expiresAt: true },
      })
    : [];
  const state: Record<string, string> = {};
  let fired = 0;
  for (const key of keys) {
    if (!key.expiresAt) continue;
    const stamp = key.expiresAt.toISOString();
    state[key.id] = stamp;
    if (previous[key.id] === stamp) continue;
    const left = daysUntil(key.expiresAt, now);
    await fireAlert(
      "key_expiring",
      `key ${key.keyAlias || key.prefix} expires at ${stamp} (in ${left} ${left === 1 ? "day" : "days"})`,
    );
    await prisma.gatewayAuditLog.create({
      data: {
        actor: "worker",
        action: "key_expiry_alert",
        objectType: "key",
        objectId: key.id,
        afterJson: JSON.stringify({ expiresAt: stamp, days: left }),
      },
    });
    fired += 1;
  }
  if (!sameState(previous, state)) await saveAlertState("key_expiry", state);
  return fired;
}

async function windowTraffic(now: Date, rule: TrafficAlertRule): Promise<TrafficScope[]> {
  const rows = await prisma.requestLog.groupBy({
    by: ["model", "status"],
    where: { createdAt: trafficWindow(now, rule.windowMinutes) },
    _count: { _all: true },
  });
  return trafficScopes(rows.map((row) => ({ model: row.model, status: row.status, count: row._count._all })));
}

async function settleIncidents<T extends { scope: TrafficScope }>(
  kind: AlertStateKind,
  event: WebhookEvent,
  now: Date,
  incidents: T[],
  notify: (incident: T) => { message: string; details: Record<string, unknown> },
): Promise<number> {
  const previous = await getAlertState(kind);
  const { state, fire } = nextIncidentState(
    previous,
    incidents.map((incident) => incident.scope.id),
    now,
  );
  let fired = 0;
  for (const incident of incidents) {
    if (!fire.includes(incident.scope.id)) continue;
    const { message, details } = notify(incident);
    await fireAlert(event, message);
    await prisma.gatewayAuditLog.create({
      data: {
        actor: "worker",
        action: event,
        objectType: incident.scope.model ? "model" : "gateway",
        objectId: incident.scope.model || incident.scope.id,
        afterJson: JSON.stringify(details),
      },
    });
    fired += 1;
  }
  if (!sameState(previous, state)) await saveAlertState(kind, state);
  return fired;
}

export async function runErrorRateAlerts(now = new Date()): Promise<number> {
  const rule = trafficAlertRule(await getEnterprise());
  const scopes = rule.errorRatePercent > 0 ? await windowTraffic(now, rule) : [];
  const incidents = scopes.flatMap((scope) => {
    const rate = errorRate(scope.counts);
    return isErrorRateSpike(rate, rule) ? [{ scope, rate }] : [];
  });
  return settleIncidents("error_rate", "error_rate_spike", now, incidents, ({ scope, rate }) => ({
    message: errorRateMessage(scope.model, rate, rule),
    details: {
      requests: rate.requests,
      errors: rate.errors,
      percent: rate.percent,
      threshold: rule.errorRatePercent,
      windowMinutes: rule.windowMinutes,
    },
  }));
}

const latencyBaselines = new Map<string, { at: number; p95: number }>();

function latencyWhere(scope: TrafficScope, createdAt: Prisma.DateTimeFilter): Prisma.RequestLogWhereInput {
  return { createdAt, status: { not: CLIENT_CLOSED_STATUS }, ...(scope.model ? { model: scope.model } : {}) };
}

async function latencyBaseline(scope: TrafficScope, now: Date, rule: TrafficAlertRule): Promise<number> {
  const key = `${scope.id}|${rule.windowMinutes}|${rule.minRequests}`;
  const cached = latencyBaselines.get(key);
  if (cached && now.getTime() - cached.at < LATENCY_BASELINE_TTL_MS) return cached.p95;
  const where = latencyWhere(scope, latencyBaselineWindow(now, rule.windowMinutes));
  const requests = await prisma.requestLog.count({ where });
  const p95 = requests >= rule.minRequests ? await p95Latency(where) : 0;
  for (const [id, entry] of latencyBaselines) {
    if (now.getTime() - entry.at >= LATENCY_BASELINE_TTL_MS) latencyBaselines.delete(id);
  }
  latencyBaselines.set(key, { at: now.getTime(), p95 });
  return p95;
}

export async function runLatencyAlerts(now = new Date()): Promise<number> {
  const rule = trafficAlertRule(await getEnterprise());
  const enabled = rule.latencyP95Ms > 0 || rule.latencyFactor > 0;
  const scopes = enabled ? await windowTraffic(now, rule) : [];
  const incidents = [];
  for (const scope of scopes) {
    const requests = answeredRequests(scope.counts);
    if (requests < rule.minRequests) continue;
    const p95 = await p95Latency(latencyWhere(scope, trafficWindow(now, rule.windowMinutes)));
    const baseline = rule.latencyFactor > 0 ? await latencyBaseline(scope, now, rule) : 0;
    const spike = latencySpike(p95, baseline, rule);
    if (spike.absolute || spike.relative) incidents.push({ scope, latency: { p95, baseline, requests }, spike });
  }
  return settleIncidents("latency", "latency_spike", now, incidents, ({ scope, latency, spike }) => ({
    message: latencyMessage(scope.model, latency, spike, rule),
    details: {
      ...latency,
      threshold: rule.latencyP95Ms,
      factor: rule.latencyFactor,
      windowMinutes: rule.windowMinutes,
    },
  }));
}
