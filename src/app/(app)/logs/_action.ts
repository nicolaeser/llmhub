"use server";

import prisma from "@/lib/db/prisma";
import { requirePermission } from "@/lib/auth/guards";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { seesAllSpend } from "@/lib/auth/scope";
import { writeAudit } from "@/lib/gateway/audit";
import { findRequestLogDetail, requestLogLabels, requestLogRow } from "@/lib/gateway/request-log-detail";
import {
  auditLogWhere,
  parseLogFilters,
  requestLogWhere,
  spendEventWhere,
} from "@/lib/gateway/request-log-query";
import { actionFail, runAction } from "@/lib/http/action-result";
import { money } from "@/lib/utils/money";
import type { LogOptions } from "@/types/logs";

const OPTION_LIMIT = 500;

export async function loadLogsAction(input?: { page?: number; pageSize?: number; filters?: unknown }) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.SPEND_READ);
    const scoped = seesAllSpend(session);
    const owner = scoped ? null : session.user.id;
    const page = Math.max(1, Math.trunc(input?.page ?? 1) || 1);
    const pageSize = Math.min(100, Math.max(10, Math.trunc(input?.pageSize ?? 50) || 50));
    const skip = (page - 1) * pageSize;
    const filters = parseLogFilters(input?.filters);
    const requestWhere = requestLogWhere(filters, owner);
    const spendWhere = spendEventWhere(filters, owner);
    const auditWhere = auditLogWhere(filters);
    const [requests, spend, audit, requestTotal, spendTotal, auditTotal] = await Promise.all([
      prisma.requestLog.findMany({
        where: requestWhere,
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
        include: { content: { select: { logId: true } } },
      }),
      prisma.spendEvent.findMany({
        where: spendWhere,
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
      }),
      scoped
        ? prisma.gatewayAuditLog.findMany({
            where: auditWhere,
            orderBy: { createdAt: "desc" },
            skip,
            take: pageSize,
          })
        : Promise.resolve([]),
      prisma.requestLog.count({ where: requestWhere }),
      prisma.spendEvent.count({ where: spendWhere }),
      scoped ? prisma.gatewayAuditLog.count({ where: auditWhere }) : 0,
    ]);
    const names = await requestLogLabels(requests);
    return {
      canAudit: scoped,
      page,
      pageSize,
      requestTotal,
      spendTotal,
      auditTotal,
      requests: requests.map((row) => requestLogRow(row, names)),
      spend: spend.map((r) => ({
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        model: r.model,
        spend: money(r.cost),
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
      })),
      audit: audit.map((r) => ({
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        actor: r.actor,
        action: r.action,
        objectType: r.objectType,
        objectId: r.objectId,
        before: r.beforeJson,
        after: r.afterJson,
      })),
    };
  });
}

export async function loadLogOptionsAction() {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.SPEND_READ);
    const scoped = seesAllSpend(session);
    const [keys, users] = await Promise.all([
      prisma.virtualKey.findMany({
        where: scoped ? {} : { userId: session.user.id },
        orderBy: { keyAlias: "asc" },
        take: OPTION_LIMIT,
        select: { id: true, keyAlias: true, prefix: true },
      }),
      scoped
        ? prisma.user.findMany({
            orderBy: { username: "asc" },
            take: OPTION_LIMIT,
            select: { id: true, username: true },
          })
        : [],
    ]);
    return {
      keys: keys.map((key) => ({ id: key.id, label: key.keyAlias || key.prefix })),
      users: users.map((user) => ({ id: user.id, label: user.username })),
    } satisfies LogOptions;
  });
}

export async function loadLogDetailAction(id: string) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.SPEND_READ);
    if (typeof id !== "string" || !id) return actionFail("MISSING_ID");
    const detail = await findRequestLogDetail(session, id);
    if (!detail) return actionFail("NOT_FOUND");
    if (detail.content) {
      await writeAudit({
        actor: session.user.id,
        action: "log.content_view",
        objectType: "request_log",
        objectId: detail.id,
      });
    }
    return detail;
  });
}
