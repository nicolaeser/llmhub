import "server-only";

import { purgeAuthRecords } from "@/lib/auth/cleanup";
import { ATTEMPT_RETENTION_MS } from "@/lib/auth/throttle";
import prisma from "@/lib/db/prisma";
import { fireAlert } from "@/lib/gateway/alerts";
import { runPendingBatches } from "@/lib/gateway/batches";
import { crossedThresholds, forecastBudget } from "@/lib/gateway/forecast";
import { purgeStoredObjects } from "@/lib/gateway/objects";
import { getBudgetAlertState, getEnterprise, saveBudgetAlertState } from "@/lib/gateway/settings";
import { retentionCutoff } from "./retention";
import type { MaintenanceSweepResult } from "@/types/jobs";
import { money } from "@/lib/utils/money";

export async function runMaintenanceSweep(
  now = new Date(),
): Promise<MaintenanceSweepResult> {
  const attemptCutoff = new Date(now.getTime() - ATTEMPT_RETENTION_MS);
  const [sessions, resetTokens, loginAttempts, tempBudgets, rotatedKeys] =
    await Promise.all([
      prisma.session.deleteMany({ where: { expiresAt: { lt: now } } }),
      prisma.passwordResetToken.deleteMany({
        where: {
          OR: [{ expiresAt: { lt: now } }, { usedAt: { not: null } }],
        },
      }),
      prisma.loginAttempt.deleteMany({
        where: { createdAt: { lt: attemptCutoff } },
      }),
      prisma.tempBudget.deleteMany({ where: { until: { lt: now } } }),
      prisma.virtualKey.updateMany({
        where: { prevHashUntil: { not: null, lt: now } },
        data: { prevHash: "", prevHashUntil: null },
      }),
    ]);
  const auth = await purgeAuthRecords(now);

  const result: MaintenanceSweepResult = {
    sessions: sessions.count + auth.sessions,
    resetTokens: resetTokens.count,
    loginAttempts: loginAttempts.count,
    tempBudgets: tempBudgets.count,
    rotatedKeys: rotatedKeys.count,
    requestLogs: 0,
    requestContents: 0,
    spendEvents: 0,
    auditLogs: 0,
    storedObjects: 0,
    batches: 0,
  };

  const enterprise = await getEnterprise().catch(() => null);
  const logCutoff = retentionCutoff(enterprise?.log_retention_days ?? 0, now);
  if (logCutoff) {
    const requestLogs = await prisma.requestLog.deleteMany({
      where: { createdAt: { lt: logCutoff } },
    });
    result.requestLogs = requestLogs.count;
  }
  const contentCutoff = retentionCutoff(enterprise?.content_retention_days ?? 0, now);
  if (contentCutoff) {
    const requestContents = await prisma.requestLogContent.deleteMany({
      where: { createdAt: { lt: contentCutoff } },
    });
    result.requestContents = requestContents.count;
  }
  const spendCutoff = retentionCutoff(enterprise?.spend_retention_days ?? 0, now);
  if (spendCutoff) {
    const spendEvents = await prisma.spendEvent.deleteMany({
      where: { createdAt: { lt: spendCutoff } },
    });
    result.spendEvents = spendEvents.count;
  }
  const auditCutoff = retentionCutoff(enterprise?.audit_retention_days ?? 0, now);
  if (auditCutoff) {
    const auditLogs = await prisma.gatewayAuditLog.deleteMany({
      where: { createdAt: { lt: auditCutoff } },
    });
    result.auditLogs = auditLogs.count;
  }
  result.storedObjects = await purgeStoredObjects({
    generatedBefore: retentionCutoff(enterprise?.object_retention_days ?? 30, now),
    uploadsBefore: retentionCutoff(enterprise?.file_retention_days ?? 0, now),
  }).catch(() => 0);
  result.batches = await runPendingBatches().catch(() => 0);
  await runSpendResets(now).catch(() => 0);
  await runBudgetAlerts().catch(() => 0);
  return result;
}

export async function runSpendResets(now = new Date()): Promise<number> {
  const { periodElapsed } = await import("@/lib/gateway/period");
  const data = { spend: 0, spendResetAt: now };
  let n = 0;
  const keys = await prisma.virtualKey.findMany({
    select: {
      id: true,
      budgetDuration: true,
      spendResetAt: true,
      createdAt: true,
    },
  });
  for (const row of keys) {
    if (!periodElapsed(row.budgetDuration, row.spendResetAt, now, row.createdAt)) {
      continue;
    }
    await prisma.virtualKey.update({ where: { id: row.id }, data });
    n += 1;
  }
  const users = await prisma.user.findMany({
    select: {
      id: true,
      budgetDuration: true,
      spendResetAt: true,
      createdAt: true,
    },
  });
  for (const row of users) {
    if (!periodElapsed(row.budgetDuration, row.spendResetAt, now, row.createdAt)) {
      continue;
    }
    await prisma.user.update({ where: { id: row.id }, data });
    n += 1;
  }
  const teams = await prisma.team.findMany({
    select: {
      id: true,
      budgetDuration: true,
      spendResetAt: true,
      createdAt: true,
    },
  });
  for (const row of teams) {
    if (!periodElapsed(row.budgetDuration, row.spendResetAt, now, row.createdAt)) {
      continue;
    }
    await prisma.team.update({ where: { id: row.id }, data });
    n += 1;
  }
  const orgs = await prisma.organization.findMany({
    select: {
      id: true,
      budgetDuration: true,
      spendResetAt: true,
      createdAt: true,
    },
  });
  for (const row of orgs) {
    if (!periodElapsed(row.budgetDuration, row.spendResetAt, now, row.createdAt)) {
      continue;
    }
    await prisma.organization.update({ where: { id: row.id }, data });
    n += 1;
  }
  const projects = await prisma.project.findMany({
    select: {
      id: true,
      budgetDuration: true,
      spendResetAt: true,
      createdAt: true,
    },
  });
  for (const row of projects) {
    if (!periodElapsed(row.budgetDuration, row.spendResetAt, now, row.createdAt)) {
      continue;
    }
    await prisma.project.update({ where: { id: row.id }, data });
    n += 1;
  }
  return n;
}

export async function runBudgetAlerts(): Promise<number> {
  const enterprise = await getEnterprise();
  const thresholds = enterprise.budget_alert_thresholds?.length
    ? enterprise.budget_alert_thresholds
    : [50, 80, 100];
  const state = await getBudgetAlertState();
  const [keys, users, teams, orgs, projects] = await Promise.all([
    prisma.virtualKey.findMany({
      select: {
        id: true,
        keyAlias: true,
        prefix: true,
        spend: true,
        maxBudget: true,
      },
    }),
    prisma.user.findMany({
      where: { maxBudget: { gt: 0 } },
      select: { id: true, username: true, spend: true, maxBudget: true },
    }),
    prisma.team.findMany({
      select: { id: true, alias: true, spend: true, maxBudget: true },
    }),
    prisma.organization.findMany({
      select: { id: true, alias: true, spend: true, maxBudget: true },
    }),
    prisma.project.findMany({
      select: { id: true, alias: true, spend: true, maxBudget: true },
    }),
  ]);
  const entities = [
    ...keys.map((k) => ({
      kind: "key",
      id: k.id,
      alias: k.keyAlias || k.prefix,
      spend: money(k.spend),
      cap: money(k.maxBudget),
    })),
    ...users.map((u) => ({
      kind: "user",
      id: u.id,
      alias: u.username,
      spend: money(u.spend),
      cap: money(u.maxBudget),
    })),
    ...teams.map((t) => ({
      kind: "team",
      id: t.id,
      alias: t.alias,
      spend: money(t.spend),
      cap: money(t.maxBudget),
    })),
    ...orgs.map((o) => ({
      kind: "org",
      id: o.id,
      alias: o.alias,
      spend: money(o.spend),
      cap: money(o.maxBudget),
    })),
    ...projects.map((p) => ({
      kind: "project",
      id: p.id,
      alias: p.alias,
      spend: money(p.spend),
      cap: money(p.maxBudget),
    })),
  ];
  let fired = 0;
  for (const entity of entities) {
    if (entity.cap <= 0) continue;
    const crossed = crossedThresholds(
      forecastBudget(entity.spend, entity.cap, 30).pctUsed,
      thresholds,
    );
    const highest = crossed[crossed.length - 1];
    if (highest == null) continue;
    const stamp = `${Math.round(entity.cap)}:${highest}`;
    const key = `${entity.kind}:${entity.id}`;
    if (state[key] === stamp) continue;
    await fireAlert(
      "budget_threshold",
      `${entity.kind} ${entity.alias} crossed ${highest}% (${entity.spend}/${entity.cap})`,
    );
    await prisma.gatewayAuditLog.create({
      data: {
        actor: "worker",
        action: "budget_alert",
        objectType: entity.kind,
        objectId: entity.id,
        afterJson: JSON.stringify({
          threshold: highest,
          spend: money(entity.spend),
          cap: entity.cap,
        }),
      },
    });
    state[key] = stamp;
    fired += 1;
  }
  if (fired) await saveBudgetAlertState(state);
  return fired;
}
