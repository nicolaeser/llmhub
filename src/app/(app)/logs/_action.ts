"use server";

import prisma from "@/lib/db/prisma";
import { requirePermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { companyOf, seesAllSpend, spendScope } from "@/lib/auth/scope";
import { writeAudit } from "@/lib/gateway/audit";
import { requestTranscript, responseTranscript } from "@/lib/gateway/log-content";
import {
  auditLogWhere,
  parseLogFilters,
  requestLogWhere,
  spendEventWhere,
} from "@/lib/gateway/request-log-query";
import { actionFail, runAction } from "@/lib/http/action-result";
import { money } from "@/lib/utils/money";
import type { RequestLog } from "@/generated/prisma/client";
import type { LogOptions, RequestLogDetail, RequestLogRow } from "@/types/logs";

const OPTION_LIMIT = 500;

async function labels(rows: { keyId: string; userId: string; memberId: string }[]) {
  const keyIds = [...new Set(rows.map((row) => row.keyId).filter(Boolean))];
  const userIds = [...new Set(rows.map((row) => row.userId).filter(Boolean))];
  const memberIds = [...new Set(rows.map((row) => row.memberId).filter(Boolean))];
  const [keys, users, members] = await Promise.all([
    keyIds.length
      ? prisma.virtualKey.findMany({
          where: { id: { in: keyIds } },
          select: { id: true, keyAlias: true, prefix: true },
        })
      : [],
    userIds.length
      ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true } })
      : [],
    memberIds.length
      ? prisma.member.findMany({ where: { id: { in: memberIds } }, select: { id: true, name: true } })
      : [],
  ]);
  return {
    keys: new Map(keys.map((key) => [key.id, key.keyAlias || key.prefix])),
    users: new Map(users.map((user) => [user.id, user.username])),
    members: new Map(members.map((member) => [member.id, member.name])),
  };
}

function rowView(
  row: RequestLog & { content: { logId: string } | null },
  names: Awaited<ReturnType<typeof labels>>,
): RequestLogRow {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    model: row.model,
    endpoint: row.endpoint,
    stream: row.stream,
    status: row.status,
    outcome: row.outcome,
    latencyMs: row.latencyMs,
    keyId: row.keyId,
    keyLabel: names.keys.get(row.keyId) ?? "",
    userId: row.userId,
    userLabel: names.users.get(row.userId) ?? "",
    memberId: row.memberId,
    memberLabel: names.members.get(row.memberId) ?? "",
    teamId: row.teamId,
    orgId: row.orgId,
    projectId: row.projectId,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    cost: money(row.cost),
    piiMode: row.piiMode,
    piiInput: row.piiInput,
    piiOutput: row.piiOutput,
    hasContent: Boolean(row.content),
    contentSkip: row.contentSkip,
  };
}

export async function loadLogsAction(input?: { page?: number; pageSize?: number; filters?: unknown }) {
  return runAction(async () => {
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
    const names = await labels(requests);
    return {
      canAudit: scoped,
      page,
      pageSize,
      requestTotal,
      spendTotal,
      auditTotal,
      requests: requests.map((row) => rowView(row, names)),
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
    const company = companyOf(session);
    const scoped = seesAllSpend(session);
    const [keys, users] = await Promise.all([
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
      keys: keys.map((key) => ({ id: key.id, label: key.keyAlias || key.prefix })),
      users: users.map((user) => ({ id: user.id, label: user.username })),
    } satisfies LogOptions;
  });
}

export async function loadLogDetailAction(id: string) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.SPEND_READ);
    if (typeof id !== "string" || !id) return actionFail("MISSING_ID");
    const canViewContent = hasPerm(session.permissions, PERMISSIONS.LOGS_CONTENT);
    const row = await prisma.requestLog.findFirst({
      where: { id, ...spendScope(session) },
      include: { content: { select: { logId: true } } },
    });
    if (!row) return actionFail("NOT_FOUND");
    const [names, team, org, project, content] = await Promise.all([
      labels([row]),
      row.teamId ? prisma.team.findUnique({ where: { id: row.teamId }, select: { alias: true } }) : null,
      row.orgId ? prisma.organization.findUnique({ where: { id: row.orgId }, select: { alias: true } }) : null,
      row.projectId ? prisma.project.findUnique({ where: { id: row.projectId }, select: { alias: true } }) : null,
      canViewContent && row.content ? prisma.requestLogContent.findUnique({ where: { logId: row.id } }) : null,
    ]);
    if (content) {
      await writeAudit({
        actor: session.user.id,
        action: "log.content_view",
        objectType: "request_log",
        objectId: row.id,
      });
    }
    return {
      ...rowView(row, names),
      teamLabel: team?.alias ?? "",
      orgLabel: org?.alias ?? "",
      projectLabel: project?.alias ?? "",
      deploymentId: row.deploymentId,
      provider: row.provider,
      upstreamModel: row.upstreamModel,
      tag: row.tag,
      error: row.error,
      canViewContent,
      content: content
        ? {
            request: content.request,
            response: content.response,
            truncated: content.truncated,
            input: requestTranscript(content.request),
            output: responseTranscript(content.response),
          }
        : null,
    } satisfies RequestLogDetail;
  });
}
