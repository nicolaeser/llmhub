import "server-only";

import prisma from "@/lib/db/prisma";
import { fireAlert } from "@/lib/gateway/alerts";
import {
  anomalyLookbackDays,
  daysUntil,
  DEFAULT_KEY_EXPIRY_WARNING_DAYS,
  expiryWindow,
  historyDays,
  isSpendAnomaly,
  nextAnomalyState,
  recentHour,
  sameHourWindows,
  sameState,
  spendAnomalyRule,
  usd,
} from "@/lib/gateway/alert-rules";
import { getAlertState, getEnterprise, saveAlertState } from "@/lib/gateway/settings";
import { money } from "@/lib/utils/money";
import type { Prisma } from "@/generated/prisma/client";

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
