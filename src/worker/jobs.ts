import "server-only";

import { purgeAuthRecords } from "@/lib/auth/cleanup";
import { ATTEMPT_RETENTION_MS } from "@/lib/auth/throttle";
import prisma from "@/lib/db/prisma";
import { fireAlert } from "@/lib/alerts/notify";
import { runPendingBatches } from "@/lib/gateway/endpoints/batches";
import { refreshDueLogins } from "@/lib/gateway/upstreams/credentials";
import { pruneSupersededLogins } from "@/lib/providers/account-match";
import { pruneSubAddLinks } from "@/lib/providers/sub-add-prune";
import { runAutoResets } from "@/lib/gateway/upstreams/reset-redeem";
import { refreshDueLimits } from "@/lib/providers/limit-refresh";
import { crossedThresholds, forecastBudget } from "@/lib/usage/forecast";
import { purgeStoredObjects } from "@/lib/gateway/storage/objects";
import { runPendingIngests } from "@/lib/rag/ingest";
import { expireVectorStores, purgeOrphanUploads } from "@/lib/rag/stores";
import { getAlertState, getEnterprise, saveAlertState } from "@/lib/settings/enterprise";
import { DEFAULT_OBJECT_RETENTION_DAYS } from "@/lib/settings/retention-defaults";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { QUEUE_NAMES } from "@/lib/jobs/queues";
import { runUsageReports } from "@/lib/reports/usage-report";
import { reportWorkerJobFailure } from "@/lib/sentry/worker-jobs";
import { runKeyExpiryAlerts, runSpendAnomalyAlerts } from "./alert-checks";
import { retentionCutoff } from "./retention";
import { runRetentionSweep } from "./retention-sweep";
import type { MaintenanceSweepResult, SpendResetRow } from "@/types/jobs";
import { money } from "@/lib/utils/money";

export async function runSweepJob(name: string, job: () => Promise<number>): Promise<number> {
  try {
    return await job();
  } catch (err) {
    logger.error("worker.job_failed", { job: name, ...errorFields(err) });
    reportWorkerJobFailure(err, { queue: QUEUE_NAMES.maintenance, step: name, finalAttempt: true });
    return 0;
  }
}

async function sweepSettings() {
  try {
    return await getEnterprise();
  } catch (err) {
    logger.error("worker.settings_failed", errorFields(err));
    reportWorkerJobFailure(err, { queue: QUEUE_NAMES.maintenance, step: "settings", finalAttempt: true });
    return null;
  }
}

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
    securityEvents: 0,
    toolExecutions: 0,
    approvalRequests: 0,
    usageRows: 0,
    usageLabelRows: 0,
    retentionBacklog: 0,
    storedObjects: 0,
    batches: 0,
    vectorFiles: 0,
    vectorStores: 0,
    reports: 0,
    signIns: 0,
    supersededLogins: 0,
    subAddLinks: 0,
    limits: 0,
    resets: 0,
  };

  const enterprise = await sweepSettings();
  if (enterprise) {
    await runSweepJob("retention", async () => {
      const run = await runRetentionSweep(enterprise, now);
      if (!run) return 0;
      Object.assign(result, run.deleted, { retentionBacklog: run.backlog.length });
      return Object.values(run.deleted).reduce((sum, count) => sum + count, 0);
    });
    result.storedObjects = await runSweepJob("stored_objects", () =>
      purgeStoredObjects({
        generatedBefore: retentionCutoff(enterprise.object_retention_days ?? DEFAULT_OBJECT_RETENTION_DAYS, now),
        uploadsBefore: retentionCutoff(enterprise.file_retention_days ?? 0, now),
      }),
    );
  }
  result.batches = await runSweepJob("batches", () => runPendingBatches());
  result.vectorStores = await runSweepJob("vector_stores", () => expireVectorStores(now));
  result.storedObjects += await runSweepJob("orphan_uploads", () => purgeOrphanUploads(now));
  result.vectorFiles = await runSweepJob("vector_ingests", () => runPendingIngests());
  await runSweepJob("spend_resets", () => runSpendResets(now));
  await runSweepJob("budget_alerts", () => runBudgetAlerts());
  await runSweepJob("spend_anomaly_alerts", () => runSpendAnomalyAlerts(now));
  await runSweepJob("key_expiry_alerts", () => runKeyExpiryAlerts(now));
  result.reports = await runSweepJob("usage_reports", () => runUsageReports(now));
  result.signIns = await runSweepJob("sign_in_refresh", () => refreshDueLogins(now.getTime()));
  result.supersededLogins = await runSweepJob("superseded_logins", async () => (await pruneSupersededLogins("worker")).length);
  result.subAddLinks = await runSweepJob("sub_add_links", async () => (await pruneSubAddLinks("worker", now.getTime())).length);
  result.limits = await runSweepJob("subscription_limits", () => refreshDueLimits(now.getTime()));
  result.resets = await runSweepJob("auto_resets", () => runAutoResets(now.getTime()));
  return result;
}

const RESET_SELECT = { id: true, budgetDuration: true, spendResetAt: true, createdAt: true } as const;

async function resetElapsedPeriods(
  rows: SpendResetRow[],
  now: Date,
  reset: (where: { id: string; spendResetAt: Date | null }) => Promise<{ count: number }>,
): Promise<number> {
  const { periodElapsed } = await import("@/lib/gateway/billing/period");
  let n = 0;
  for (const row of rows) {
    if (!periodElapsed(row.budgetDuration, row.spendResetAt, now, row.createdAt)) continue;
    n += (await reset({ id: row.id, spendResetAt: row.spendResetAt })).count;
  }
  return n;
}

export async function runSpendResets(now = new Date()): Promise<number> {
  const data = { spend: 0, spendResetAt: now };
  let n = 0;
  n += await resetElapsedPeriods(await prisma.virtualKey.findMany({ select: RESET_SELECT }), now, (where) =>
    prisma.virtualKey.updateMany({ where, data }),
  );
  n += await resetElapsedPeriods(await prisma.user.findMany({ select: RESET_SELECT }), now, (where) =>
    prisma.user.updateMany({ where, data }),
  );
  n += await resetElapsedPeriods(await prisma.member.findMany({ select: RESET_SELECT }), now, (where) =>
    prisma.member.updateMany({ where, data }),
  );
  n += await resetElapsedPeriods(await prisma.team.findMany({ select: RESET_SELECT }), now, (where) =>
    prisma.team.updateMany({ where, data }),
  );
  n += await resetElapsedPeriods(await prisma.organization.findMany({ select: RESET_SELECT }), now, (where) =>
    prisma.organization.updateMany({ where, data }),
  );
  n += await resetElapsedPeriods(await prisma.project.findMany({ select: RESET_SELECT }), now, (where) =>
    prisma.project.updateMany({ where, data }),
  );
  return n;
}

export async function runBudgetAlerts(): Promise<number> {
  const enterprise = await getEnterprise();
  const thresholds = enterprise.budget_alert_thresholds?.length
    ? enterprise.budget_alert_thresholds
    : [50, 80, 100];
  const state = await getAlertState("budget");
  const [keys, users, members, teams, orgs, projects] = await Promise.all([
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
    prisma.member.findMany({
      where: { maxBudget: { gt: 0 } },
      select: { id: true, name: true, spend: true, maxBudget: true },
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
    ...members.map((m) => ({
      kind: "member",
      id: m.id,
      alias: m.name,
      spend: money(m.spend),
      cap: money(m.maxBudget),
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
  if (fired) await saveAlertState("budget", state);
  return fired;
}
