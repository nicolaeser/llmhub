import "server-only";
import prisma from "@/lib/db/prisma";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { spendScopeKey } from "@/lib/auth/scope";
import type { LiveFeed, LiveRequests } from "@/types/live";
import type { SpendScope } from "@/types/structure";

export async function latestRequests(scope: SpendScope): Promise<LiveRequests> {
  const platform = !scope.orgId && !scope.userId;
  const latest = { orderBy: { createdAt: "desc" as const }, select: { id: true, createdAt: true } };
  const [request, audit] = await Promise.all([
    prisma.requestLog.findFirst({ where: { ...scope }, ...latest }),
    platform ? prisma.gatewayAuditLog.findFirst(latest) : null,
  ]);
  return {
    at: Date.now(),
    requestId: request?.id ?? null,
    requestAt: request?.createdAt.toISOString() ?? null,
    auditId: audit?.id ?? null,
    auditAt: audit?.createdAt.toISOString() ?? null,
  };
}

export const REQUESTS_FEED: LiveFeed<LiveRequests> = {
  topic: "requests",
  permission: PERMISSIONS.SPEND_READ,
  pollMs: 5_000,
  minGapMs: 2_000,
  scopeKey: spendScopeKey,
  load: (scope) => latestRequests(scope),
  full: (state) => state,
  change: (previous, next) =>
    previous.requestId === next.requestId && previous.auditId === next.auditId ? null : next,
};
