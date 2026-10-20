import "server-only";

import prisma from "@/lib/db/prisma";
import { requirePermission } from "@/lib/auth/guards";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { companyOf, seesAllSpend, spendScope } from "@/lib/auth/scope";
import { writeAudit } from "@/lib/audit";
import {
  findRequestLogDetail,
  requestLogLabels,
  requestLogRow,
} from "@/lib/gateway/request-logs/request-log-detail";
import {
  auditLogWhere,
  parseLogFilters,
  requestLogWhere,
  spendEventWhere,
} from "@/lib/gateway/request-logs/request-log-query";
import { money } from "@/lib/utils/money";
import type { LogOptions } from "@/types/logs";

const OPTION_LIMIT = 500;
const NEW_LOGS_CAP = 1000;

export async function loadLogs(input?: { page?: number; pageSize?: number; filters?: unknown }) {
  const session = await requirePermission(PERMISSIONS.SPEND_READ);
  const scoped = seesAllSpend(session) && !companyOf(session);
  const scope = spendScope(session);
  const page = Math.max(1, Math.trunc(input?.page ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(10, Math.trunc(input?.pageSize ?? 50) || 50));
  const skip = (page - 1) * pageSize;
  const filters = parseLogFilters(input?.filters);
  const requestWhere = requestLogWhere(filters, scope);
  const spendWhere = spendEventWhere(filters, scope);
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
  const [names, actors] = await Promise.all([
    requestLogLabels(requests),
    audit.length
      ? prisma.user.findMany({
          where: { id: { in: [...new Set(audit.map((row) => row.actor))] } },
          select: { id: true, username: true },
        })
      : [],
  ]);
  const actorNames = new Map(actors.map((user) => [user.id, user.username]));
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
      actor: actorNames.get(r.actor) ?? r.actor,
      action: r.action,
      objectType: r.objectType,
      objectId: r.objectId,
      before: r.beforeJson,
      after: r.afterJson,
    })),
  };
}

export async function countNewLogs(input: { since: string; filters?: unknown }) {
  const session = await requirePermission(PERMISSIONS.SPEND_READ);
  const since = new Date(typeof input?.since === "string" ? input.since : "");
  if (Number.isNaN(since.getTime())) throw new Error("VALIDATION");
  const where = requestLogWhere(parseLogFilters(input.filters), spendScope(session));
  const count = await prisma.requestLog.count({
    where: { AND: [where, { createdAt: { gt: since } }] },
    take: NEW_LOGS_CAP,
  });
  return { count, capped: count >= NEW_LOGS_CAP };
}

export async function loadLogOptions() {
  const session = await requirePermission(PERMISSIONS.SPEND_READ);
  const company = companyOf(session);
  const scoped = seesAllSpend(session);
  const [models, keys, users] = await Promise.all([
    prisma.modelGroup.findMany({ orderBy: { alias: "asc" }, take: OPTION_LIMIT, select: { alias: true } }),
    prisma.virtualKey.findMany({
      where: {
        ...(company ? { orgId: company } : {}),
        ...(scoped ? {} : { userId: session.user.id }),
      },
      orderBy: { keyAlias: "asc" },
      take: OPTION_LIMIT,
      select: { id: true, keyAlias: true, prefix: true },
    }),
    scoped
      ? prisma.user.findMany({
          where: company ? { orgId: company } : {},
          orderBy: { username: "asc" },
          take: OPTION_LIMIT,
          select: { id: true, username: true },
        })
      : [],
  ]);
  return {
    models: models.map((model) => model.alias),
    keys: keys.map((key) => ({ id: key.id, label: key.keyAlias || key.prefix })),
    users: users.map((user) => ({ id: user.id, label: user.username })),
  } satisfies LogOptions;
}

export async function loadLogDetail(id: string) {
  const session = await requirePermission(PERMISSIONS.SPEND_READ);
  if (typeof id !== "string" || !id) throw new Error("MISSING_ID");
  const detail = await findRequestLogDetail(session, id);
  if (!detail) throw new Error("NOT_FOUND");
  if (detail.content) {
    await writeAudit({
      actor: session.user.id,
      action: "log.content_view",
      objectType: "request_log",
      objectId: detail.id,
    });
  }
  return detail;
}
