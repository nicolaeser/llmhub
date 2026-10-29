import "server-only";

import prisma from "@/lib/db/prisma";
import { requirePermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { companyOf, spendScope } from "@/lib/auth/scope";
import { asRecord } from "@/lib/gateway/core";
import { CLIENT_CLOSED_STATUS } from "@/lib/gateway/errors";
import { requestTranscript, responseTranscript } from "@/lib/gateway/request-logs/log-content";
import { requestLogLabels, requestLogRow } from "@/lib/gateway/request-logs/request-log-detail";
import { parseLogFilters, requestLogWhere } from "@/lib/gateway/request-logs/request-log-query";
import { SessionChatBuilder } from "@/lib/gateway/request-logs/session-chat";
import {
  ACTIVE_SESSION_MS,
  accountSwitchFlags,
  countAccountSwitches,
  countPinnedAccounts,
  leadingAgent,
  sessionKey,
  sessionModels,
  sessionSpan,
  switchesPossible,
} from "@/lib/gateway/request-logs/session-stats";
import { money } from "@/lib/utils/money";
import type { Prisma } from "@/generated/prisma/client";
import type { AuthenticatedSession } from "@/types/auth";
import type {
  AccountStep,
  LogFilterValues,
  LogSessionAccount,
  LogSessionChat,
  LogSessionDetail,
  LogSessionList,
  LogSessionRef,
  LogSessionRow,
  LogSessionSort,
  LogSessionSortKey,
} from "@/types/logs";
import type { SpendScope } from "@/types/structure";

export const SESSION_EXPORT_LIMIT = 1_000;
const SESSION_COUNT_CAP = 10_000;
const TIMELINE_PAGE_SIZE = 100;
const CHAT_REQUEST_LIMIT = 200;
const CHAT_CHUNK_SIZE = 20;
const MAX_SESSION_ID = 512;
const MAX_REF_ID = 64;
const FAILED: Prisma.RequestLogWhereInput = { status: { gte: 400, not: CLIENT_CLOSED_STATUS } };
const WITH_ACCOUNT: Prisma.RequestLogWhereInput = { providerId: { not: "" } };
const TIMELINE_ORDER: Prisma.RequestLogOrderByWithRelationInput[] = [{ createdAt: "asc" }, { id: "asc" }];
const SESSION_SORTS: readonly LogSessionSortKey[] = ["recent", "cost", "requests"];
const RECENT_FIRST: LogSessionSort = { by: "recent", direction: "desc" };

function refOf(row: LogSessionRef): LogSessionRef {
  return { sessionId: row.sessionId, keyId: row.keyId, userId: row.userId };
}

function byKey<T extends LogSessionRef>(rows: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const key = sessionKey(row);
    const list = grouped.get(key);
    if (list) list.push(row);
    else grouped.set(key, [row]);
  }
  return grouped;
}

function sessionsWhere(filters: LogFilterValues, scope: SpendScope): Prisma.RequestLogWhereInput {
  return { AND: [requestLogWhere(filters, scope), { sessionId: { not: "" } }] };
}

export function parseSessionSort(input: unknown): LogSessionSort {
  const rec = asRecord(input);
  const by = SESSION_SORTS.find((key) => key === rec?.by);
  if (!by) return RECENT_FIRST;
  return { by, direction: rec?.direction === "asc" ? "asc" : "desc" };
}

type SessionOrder =
  | { _sum: { cost: Prisma.SortOrder } }
  | { _count: { sessionId: Prisma.SortOrder } }
  | { _max: { createdAt: Prisma.SortOrder } }
  | { sessionId: Prisma.SortOrder }
  | { keyId: Prisma.SortOrder }
  | { userId: Prisma.SortOrder };

function sessionOrder(sort: LogSessionSort): SessionOrder[] {
  const { direction } = sort;
  const lead: SessionOrder =
    sort.by === "cost"
      ? { _sum: { cost: direction } }
      : sort.by === "requests"
        ? { _count: { sessionId: direction } }
        : { _max: { createdAt: direction } };
  return [lead, { _max: { createdAt: "desc" } }, { sessionId: "asc" }, { keyId: "asc" }, { userId: "asc" }];
}

function groupSessions(where: Prisma.RequestLogWhereInput, skip: number, take: number, sort: LogSessionSort = RECENT_FIRST) {
  return prisma.requestLog.groupBy({
    by: ["sessionId", "keyId", "userId"],
    where,
    _count: { _all: true },
    _sum: { cost: true, promptTokens: true, completionTokens: true, cacheReadTokens: true, cacheWriteTokens: true },
    _min: { createdAt: true },
    _max: { createdAt: true },
    orderBy: sessionOrder(sort),
    skip,
    take,
  });
}

type SessionGroup = Awaited<ReturnType<typeof groupSessions>>[number];

async function summarize(groups: SessionGroup[], where: Prisma.RequestLogWhereInput): Promise<LogSessionRow[]> {
  if (!groups.length) return [];
  const now = Date.now();
  const refs = groups.map(refOf);
  const inPage: Prisma.RequestLogWhereInput = {
    AND: [where, { sessionId: { in: [...new Set(refs.map((ref) => ref.sessionId))] } }],
  };
  const [mix, failures, accounts, firsts] = await Promise.all([
    prisma.requestLog.groupBy({
      by: ["sessionId", "keyId", "userId", "model", "agent"],
      where: inPage,
      _count: { _all: true },
    }),
    prisma.requestLog.groupBy({ by: ["sessionId", "keyId", "userId"], where: { AND: [inPage, FAILED] }, _count: { _all: true } }),
    prisma.requestLog.groupBy({ by: ["sessionId", "keyId", "userId", "provider", "providerId"], where: { AND: [inPage, WITH_ACCOUNT] } }),
    prisma.requestLog.findMany({
      where: {
        AND: [where, { OR: groups.map((group) => ({ ...refOf(group), createdAt: group._min.createdAt ?? new Date(0) })) }],
      },
      select: { sessionId: true, keyId: true, userId: true, memberId: true, latencyMs: true },
    }),
  ]);
  const accountsBy = byKey(accounts);
  const switching = refs.filter((ref) => switchesPossible(accountsBy.get(sessionKey(ref)) ?? []));
  const [steps, labels] = await Promise.all([
    switching.length
      ? prisma.requestLog.findMany({
          where: { AND: [where, WITH_ACCOUNT, { OR: switching }] },
          orderBy: TIMELINE_ORDER,
          select: { sessionId: true, keyId: true, userId: true, provider: true, providerId: true },
        })
      : [],
    requestLogLabels(firsts),
  ]);
  const mixBy = byKey(mix);
  const failuresBy = new Map(failures.map((row) => [sessionKey(row), row._count._all]));
  const firstBy = new Map<string, (typeof firsts)[number]>();
  for (const row of firsts) {
    const key = sessionKey(row);
    const known = firstBy.get(key);
    if (!known || row.latencyMs > known.latencyMs) firstBy.set(key, row);
  }
  const stepsBy = byKey(steps);
  return groups.map((group) => {
    const ref = refOf(group);
    const key = sessionKey(ref);
    const first = firstBy.get(key);
    const lastAt = group._max.createdAt ?? new Date(0);
    const span = sessionSpan(group._min.createdAt ?? lastAt, first?.latencyMs ?? 0, lastAt);
    const counts = (mixBy.get(key) ?? []).map((row) => ({ model: row.model, agent: row.agent, requests: row._count._all }));
    const memberId = first?.memberId ?? "";
    return {
      ...ref,
      keyLabel: labels.keys.get(ref.keyId) ?? "",
      userLabel: labels.users.get(ref.userId) ?? "",
      memberId,
      memberLabel: labels.members.get(memberId) ?? "",
      agent: leadingAgent(counts),
      active: now - lastAt.getTime() < ACTIVE_SESSION_MS,
      startedAt: span.startedAt.toISOString(),
      lastAt: lastAt.toISOString(),
      durationMs: span.durationMs,
      requests: group._count._all,
      errors: failuresBy.get(key) ?? 0,
      promptTokens: group._sum.promptTokens ?? 0,
      completionTokens: group._sum.completionTokens ?? 0,
      cacheReadTokens: group._sum.cacheReadTokens ?? 0,
      cacheWriteTokens: group._sum.cacheWriteTokens ?? 0,
      cost: money(group._sum.cost),
      models: sessionModels(counts),
      accounts: countPinnedAccounts(accountsBy.get(key) ?? []),
      accountSwitches: countAccountSwitches(stepsBy.get(key) ?? []),
    };
  });
}

export async function listSessions(
  scope: SpendScope,
  filters: LogFilterValues,
  skip: number,
  take: number,
  sort: LogSessionSort = RECENT_FIRST,
): Promise<LogSessionRow[]> {
  const where = sessionsWhere(filters, scope);
  return summarize(await groupSessions(where, skip, take, sort), where);
}

function countSessions(where: Prisma.RequestLogWhereInput) {
  return prisma.requestLog.groupBy({
    by: ["sessionId", "keyId", "userId"],
    where,
    orderBy: [{ sessionId: "asc" }, { keyId: "asc" }, { userId: "asc" }],
    take: SESSION_COUNT_CAP + 1,
  });
}

export async function loadLogSessions(input?: {
  page?: number;
  pageSize?: number;
  filters?: unknown;
  sort?: unknown;
}): Promise<LogSessionList> {
  const session = await requirePermission(PERMISSIONS.SPEND_READ);
  const scope = spendScope(session);
  const page = Math.max(1, Math.trunc(input?.page ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(10, Math.trunc(input?.pageSize ?? 25) || 25));
  const filters = parseLogFilters(input?.filters);
  const sort = parseSessionSort(input?.sort);
  const where = sessionsWhere(filters, scope);
  const [sessions, counted, sums, failed, active] = await Promise.all([
    listSessions(scope, filters, (page - 1) * pageSize, pageSize, sort),
    countSessions(where),
    prisma.requestLog.aggregate({
      where,
      _count: { _all: true },
      _sum: { cost: true, promptTokens: true, completionTokens: true, cacheReadTokens: true },
    }),
    prisma.requestLog.count({ where: { AND: [where, FAILED] } }),
    countSessions({ AND: [where, { createdAt: { gte: new Date(Date.now() - ACTIVE_SESSION_MS) } }] }),
  ]);
  return {
    page,
    pageSize,
    total: Math.min(counted.length, SESSION_COUNT_CAP),
    capped: counted.length > SESSION_COUNT_CAP,
    sort,
    totals: {
      active: Math.min(active.length, SESSION_COUNT_CAP),
      requests: sums._count?._all ?? 0,
      errors: failed,
      cost: money(sums._sum?.cost ?? 0),
      promptTokens: sums._sum?.promptTokens ?? 0,
      completionTokens: sums._sum?.completionTokens ?? 0,
      cacheReadTokens: sums._sum?.cacheReadTokens ?? 0,
    },
    sessions,
  };
}

function idText(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return "";
  return typeof value === "string" && value.length <= max ? value : null;
}

export function parseSessionRef(input: unknown): LogSessionRef | null {
  const rec = asRecord(input);
  const sessionId = idText(rec?.sessionId, MAX_SESSION_ID);
  const keyId = idText(rec?.keyId, MAX_REF_ID);
  const userId = idText(rec?.userId, MAX_REF_ID);
  if (!sessionId || keyId === null || userId === null) return null;
  return { sessionId, keyId, userId };
}

async function accountNames(session: AuthenticatedSession, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length || companyOf(session) || !hasPerm(session.permissions, PERMISSIONS.PROVIDERS_READ)) return new Map();
  const rows = await prisma.providerConnection.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(rows.map((row) => [row.id, row.name]));
}

function accountOrder(steps: (AccountStep & { id: string })[]): Map<string, LogSessionAccount & { id: string }> {
  const order = new Map<string, LogSessionAccount & { id: string }>();
  for (const step of steps) {
    if (!step.providerId) continue;
    const known = order.get(step.providerId);
    if (known) known.requests++;
    else order.set(step.providerId, { id: step.providerId, index: order.size + 1, label: "", provider: step.provider, requests: 1 });
  }
  return order;
}

export async function loadLogSession(input: { ref: unknown; page?: number }): Promise<LogSessionDetail> {
  const session = await requirePermission(PERMISSIONS.SPEND_READ);
  const ref = parseSessionRef(input?.ref);
  if (!ref) throw new Error("VALIDATION");
  const where: Prisma.RequestLogWhereInput = { AND: [spendScope(session), ref] };
  const [groups, steps] = await Promise.all([
    groupSessions(where, 0, 1),
    prisma.requestLog.findMany({
      where,
      orderBy: TIMELINE_ORDER,
      select: { id: true, provider: true, providerId: true },
    }),
  ]);
  if (!groups.length || !steps.length) throw new Error("NOT_FOUND");
  const pages = Math.max(1, Math.ceil(steps.length / TIMELINE_PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Math.trunc(input?.page ?? 1) || 1));
  const start = (page - 1) * TIMELINE_PAGE_SIZE;
  const shown = steps.slice(start, start + TIMELINE_PAGE_SIZE);
  const flags = accountSwitchFlags(steps);
  const order = accountOrder(steps);
  const [[summary], rows, names] = await Promise.all([
    summarize(groups, where),
    prisma.requestLog.findMany({
      where: { AND: [where, { id: { in: shown.map((step) => step.id) } }] },
      include: { content: { select: { logId: true } } },
    }),
    accountNames(session, [...order.keys()]),
  ]);
  const labels = await requestLogLabels(rows);
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const startedAt = new Date(summary.startedAt).getTime();
  return {
    session: summary,
    accounts: [...order.values()].map(({ id, ...account }) => ({ ...account, label: names.get(id) ?? "" })),
    page,
    pageSize: TIMELINE_PAGE_SIZE,
    total: steps.length,
    requests: shown.flatMap((step, index) => {
      const row = rowsById.get(step.id);
      if (!row) return [];
      return [
        {
          ...requestLogRow(row, labels),
          provider: row.provider,
          account: order.get(row.providerId)?.index ?? 0,
          accountSwitch: flags[start + index] ?? false,
          offsetMs: Math.max(0, row.createdAt.getTime() - startedAt),
        },
      ];
    }),
  };
}

export async function loadLogSessionChat(input: { ref: unknown }): Promise<LogSessionChat> {
  const session = await requirePermission(PERMISSIONS.SPEND_READ);
  const ref = parseSessionRef(input?.ref);
  if (!ref) throw new Error("VALIDATION");
  const where: Prisma.RequestLogWhereInput = { AND: [spendScope(session), ref, { content: { isNot: null } }] };
  const canViewContent = hasPerm(session.permissions, PERMISSIONS.LOGS_CONTENT);
  const [total, newest] = await Promise.all([
    prisma.requestLog.count({ where }),
    canViewContent
      ? prisma.requestLog.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: CHAT_REQUEST_LIMIT,
          select: { id: true },
        })
      : [],
  ]);
  const ids = newest.map((row) => row.id).reverse();
  const builder = new SessionChatBuilder();
  for (let start = 0; start < ids.length; start += CHAT_CHUNK_SIZE) {
    const rows = await prisma.requestLog.findMany({
      where: { AND: [where, { id: { in: ids.slice(start, start + CHAT_CHUNK_SIZE) } }] },
      orderBy: TIMELINE_ORDER,
      include: { content: true },
    });
    for (const row of rows) {
      if (!row.content) continue;
      builder.add({
        request: {
          id: row.id,
          createdAt: row.createdAt.toISOString(),
          model: row.model,
          status: row.status,
          outcome: row.outcome,
          latencyMs: row.latencyMs,
          promptTokens: row.promptTokens,
          completionTokens: row.completionTokens,
          cacheReadTokens: row.cacheReadTokens,
          cost: money(row.cost),
          error: row.error,
        },
        input: requestTranscript(row.content.request),
        output: responseTranscript(row.content.response),
      });
    }
  }
  return { canViewContent, threads: builder.threads(), total, scanned: ids.length };
}
