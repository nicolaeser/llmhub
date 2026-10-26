import "server-only";

import prisma from "@/lib/db/prisma";
import { acquireLease, releaseLease } from "@/lib/jobs/lease";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import {
  DEFAULT_CONTENT_RETENTION_DAYS,
  DEFAULT_LOG_RETENTION_DAYS,
  DEFAULT_SECURITY_RETENTION_DAYS,
} from "@/lib/settings/retention-defaults";
import type { Enterprise } from "@/types/settings";
import { retentionCutoff, shorterRetention } from "./retention";
import type {
  RetentionOptions,
  RetentionRun,
  RetentionStep,
  RetentionSweepOptions,
  RetentionTable,
  RetentionTask,
} from "@/types/jobs";

const RETENTION_CHUNK = 1_000;
const RETENTION_BUDGET_MS = 20_000;
export const RETENTION_LEASE = "retention_sweep_lock";
const RETENTION_LEASE_MS = 50_000;

function utcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

async function deleteIds(ids: string[], take: number, remove: (ids: string[]) => Promise<{ count: number }>): Promise<RetentionStep> {
  if (!ids.length) return { deleted: 0, more: false };
  const { count } = await remove(ids);
  return { deleted: count, more: ids.length >= take };
}

const steps: Record<RetentionTable, (cutoff: Date, take: number) => Promise<RetentionStep>> = {
  requestContents: async (cutoff, take) => {
    const rows = await prisma.requestLogContent.findMany({
      where: { createdAt: { lt: cutoff } },
      orderBy: { createdAt: "asc" },
      take,
      select: { logId: true },
    });
    return deleteIds(rows.map((row) => row.logId), take, (ids) =>
      prisma.requestLogContent.deleteMany({ where: { logId: { in: ids } } }),
    );
  },
  requestLogs: async (cutoff, take) => {
    const rows = await prisma.requestLog.findMany({
      where: { createdAt: { lt: cutoff } },
      orderBy: { createdAt: "asc" },
      take,
      select: { id: true },
    });
    return deleteIds(rows.map((row) => row.id), take, (ids) => prisma.requestLog.deleteMany({ where: { id: { in: ids } } }));
  },
  toolExecutions: async (cutoff, take) => {
    const rows = await prisma.toolExecution.findMany({
      where: { startedAt: { lt: cutoff } },
      orderBy: { startedAt: "asc" },
      take,
      select: { id: true },
    });
    return deleteIds(rows.map((row) => row.id), take, (ids) =>
      prisma.toolExecution.deleteMany({ where: { id: { in: ids } } }),
    );
  },
  securityEvents: async (cutoff, take) => {
    const rows = await prisma.userSecurityEvent.findMany({
      where: { createdAt: { lt: cutoff } },
      orderBy: { createdAt: "asc" },
      take,
      select: { id: true },
    });
    return deleteIds(rows.map((row) => row.id), take, (ids) =>
      prisma.userSecurityEvent.deleteMany({ where: { id: { in: ids } } }),
    );
  },
  spendEvents: async (cutoff, take) => {
    const rows = await prisma.spendEvent.findMany({
      where: { createdAt: { lt: cutoff } },
      orderBy: { createdAt: "asc" },
      take,
      select: { id: true },
    });
    return deleteIds(rows.map((row) => row.id), take, (ids) => prisma.spendEvent.deleteMany({ where: { id: { in: ids } } }));
  },
  usageRows: async (cutoff) => {
    const oldest = await prisma.usageDaily.findFirst({
      where: { day: { lt: utcDay(cutoff) } },
      orderBy: { day: "asc" },
      select: { day: true },
    });
    if (!oldest) return { deleted: 0, more: false };
    const { count } = await prisma.usageDaily.deleteMany({ where: { day: oldest.day } });
    return { deleted: count, more: true };
  },
  usageLabelRows: async (cutoff) => {
    const oldest = await prisma.usageLabelDaily.findFirst({
      where: { day: { lt: utcDay(cutoff) } },
      orderBy: { day: "asc" },
      select: { day: true },
    });
    if (!oldest) return { deleted: 0, more: false };
    const { count } = await prisma.usageLabelDaily.deleteMany({ where: { day: oldest.day } });
    return { deleted: count, more: true };
  },
  auditLogs: async (cutoff, take) => {
    const rows = await prisma.gatewayAuditLog.findMany({
      where: { createdAt: { lt: cutoff } },
      orderBy: { createdAt: "asc" },
      take,
      select: { id: true },
    });
    return deleteIds(rows.map((row) => row.id), take, (ids) =>
      prisma.gatewayAuditLog.deleteMany({ where: { id: { in: ids } } }),
    );
  },
  approvalRequests: async (cutoff, take) => {
    const rows = await prisma.approvalRequest.findMany({
      where: { status: "rejected", decidedAt: { lt: cutoff } },
      orderBy: { decidedAt: "asc" },
      take,
      select: { id: true },
    });
    return deleteIds(rows.map((row) => row.id), take, (ids) =>
      prisma.approvalRequest.deleteMany({ where: { id: { in: ids }, status: "rejected" } }),
    );
  },
};

function retentionDaysOf(enterprise: Enterprise): Record<RetentionTable, number> {
  const log = enterprise.log_retention_days ?? DEFAULT_LOG_RETENTION_DAYS;
  const content = enterprise.content_retention_days ?? DEFAULT_CONTENT_RETENTION_DAYS;
  const audit = enterprise.audit_retention_days ?? 0;
  return {
    requestContents: content,
    requestLogs: log,
    toolExecutions: shorterRetention(log, content),
    securityEvents: enterprise.security_retention_days ?? DEFAULT_SECURITY_RETENTION_DAYS,
    spendEvents: enterprise.spend_retention_days ?? 0,
    usageRows: enterprise.usage_retention_days ?? 0,
    usageLabelRows: enterprise.usage_retention_days ?? 0,
    auditLogs: audit,
    approvalRequests: audit,
  };
}

function retentionTasks(enterprise: Enterprise, now: Date): RetentionTask[] {
  const days = retentionDaysOf(enterprise);
  return (Object.keys(steps) as RetentionTable[]).flatMap((name) => {
    const cutoff = retentionCutoff(days[name], now);
    return cutoff ? [{ name, step: (take: number) => steps[name](cutoff, take) }] : [];
  });
}

export async function runRetention(tasks: RetentionTask[], options: RetentionOptions = {}): Promise<RetentionRun> {
  const take = Math.max(1, Math.trunc(options.chunk ?? RETENTION_CHUNK));
  const clock = options.clock ?? Date.now;
  const deadline = clock() + (options.budgetMs ?? RETENTION_BUDGET_MS);
  const deleted: Partial<Record<RetentionTable, number>> = {};
  let pending = tasks;
  while (pending.length && clock() < deadline) {
    const next: RetentionTask[] = [];
    for (const task of pending) {
      if (clock() >= deadline) {
        next.push(task);
        continue;
      }
      try {
        const step = await task.step(take);
        deleted[task.name] = (deleted[task.name] ?? 0) + step.deleted;
        if (step.more) next.push(task);
      } catch (err) {
        logger.error("worker.job_failed", { job: `retention:${task.name}`, ...errorFields(err) });
      }
    }
    pending = next;
  }
  return { deleted, backlog: pending.map((task) => task.name) };
}

export async function runRetentionSweep(
  enterprise: Enterprise,
  now: Date,
  options: RetentionSweepOptions = {},
): Promise<RetentionRun | null> {
  const tasks = retentionTasks(enterprise, now);
  if (!tasks.length) return { deleted: {}, backlog: [] };
  const leaseKey = options.leaseKey ?? RETENTION_LEASE;
  const token = await acquireLease(leaseKey, RETENTION_LEASE_MS);
  if (!token) return null;
  try {
    return await runRetention(tasks, options);
  } finally {
    await releaseLease(leaseKey, token);
  }
}
