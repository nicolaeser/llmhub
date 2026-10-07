import "server-only";

import prisma from "@/lib/db/prisma";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { usageTotals } from "@/lib/gateway/usage-totals";
import { money } from "@/lib/utils/money";
import { loadUsageAction } from "@/app/(app)/_action";
import { loadLogsAction } from "@/app/(app)/logs/_action";
import { parseLogSearch, parseUsageBreakdown, searchLogs, usageBreakdown } from "@/lib/assistant/insights";
import { redactSecrets } from "@/lib/assistant/parse";
import {
  auditLogToolInput,
  emptyToolInput,
  idToolInput,
  searchLogsToolInput,
  usageBreakdownToolInput,
  usageToolInput,
} from "@/schemas/assistant";
import { defineTool, toolFail, viaAction } from "@/lib/assistant/tools/define";
import { ownKeysWhere } from "@/lib/assistant/tools/general";
import type { SliceRow } from "@/types/gateway";

const TOP_ROWS = 10;

function roundMoney(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function compactRows(rows: SliceRow[], labels: Record<string, string>) {
  return rows.slice(0, TOP_ROWS).map((row) => ({
    id: row.name,
    label: labels[row.name] ?? row.name,
    spend: roundMoney(row.spend),
    requests: row.requests ?? 0,
    errors: row.errors ?? 0,
    promptTokens: row.prompt,
    completionTokens: row.completion,
  }));
}

export const usageTools = {
  get_overview: defineTool({
    description: "Seven-day spend, request, and error counts plus setup totals.",
    input: emptyToolInput,
    run: async (_args, ctx) => {
      const [providers, models, keys, totals] = await Promise.all([
        prisma.providerConnection.count(),
        prisma.modelGroup.count(),
        prisma.virtualKey.count({ where: ownKeysWhere(ctx) }),
        usageTotals(7, {
          ...(ctx.orgId ? { orgId: ctx.orgId } : {}),
          ...(hasPerm(ctx.permissions, PERMISSIONS.SPEND_READ_ALL) ? {} : { userId: ctx.userId }),
        }),
      ]);
      return { result: { providers, models, keys, ...totals } };
    },
  }),
  get_usage: defineTool({
    description:
      "Spend, tokens, requests, errors, latency, daily series, and top models, companies, departments, projects, people, keys, and console users for the last N days. Filters narrow the result. Operators without spend:read-all only see their own internal keys and playground use.",
    input: usageToolInput,
    run: async (args) =>
      viaAction(loadUsageAction(args), (usage) => ({
        result: {
          days: usage.days,
          filters: {
            model: usage.model,
            orgId: usage.orgId,
            teamId: usage.teamId,
            projectId: usage.projectId,
            memberId: usage.memberId,
            keyId: usage.keyId,
            userId: usage.userId,
          },
          totals: {
            spend: roundMoney(usage.spend),
            tokens: usage.tokens,
            requests: usage.count,
            errors: usage.errors,
            rateLimited: usage.rate429,
            meanLatencyMs: Math.round(usage.latency),
            p95LatencyMs: usage.p95Latency,
          },
          daily: usage.daily.map((day) => ({ ...day, spend: roundMoney(day.spend) })),
          byModel: compactRows(usage.byModel, {}),
          byOrg: compactRows(usage.byOrg, usage.names),
          byTeam: compactRows(usage.byTeam, usage.names),
          byProject: compactRows(usage.byProject, usage.names),
          byMember: compactRows(usage.byMember, usage.names),
          byKey: compactRows(usage.byKey, usage.names),
          byUser: compactRows(usage.byUser, usage.names),
        },
      })),
  }),
  search_logs: defineTool({
    description:
      "Recent gateway requests, newest first, with ids, counts by status, outcome, provider, and upstream model, and the most common error messages. Metadata only, never prompts or responses. Defaults to the last 24 hours.",
    input: searchLogsToolInput,
    run: async (args, ctx) => ({ result: await searchLogs(parseLogSearch(args), ctx) }),
  }),
  usage_breakdown: defineTool({
    description:
      "Spend, requests, errors, 429s, tokens, and average latency from the daily usage rollup, grouped by model, company (org), department (team), project, person (member), key, or console user.",
    input: usageBreakdownToolInput,
    run: async (args, ctx) => ({ result: await usageBreakdown(parseUsageBreakdown(args), ctx) }),
  }),
  search_audit_log: defineTool({
    description:
      "The console audit log, newest first: who created, changed, or deleted keys, providers, models, structure, budgets, users, roles, and settings, with before and after values.",
    input: auditLogToolInput,
    run: async ({ from, to, limit, page }) =>
      viaAction(
        loadLogsAction({ page, pageSize: limit, filters: { from: from ?? "", to: to ?? "" } }),
        (logs) => {
          if (!logs.canAudit) return toolFail("forbidden");
          return { result: { total: logs.auditTotal, page, rows: logs.audit } };
        },
      ),
  }),
  get_log: defineTool({
    description:
      "One request log by id: status, outcome, error, upstream provider and model, deployment, tokens, cost, and tenancy. Never returns prompt or response content.",
    input: idToolInput,
    run: async ({ id }, ctx) => {
      const row = await prisma.requestLog.findFirst({
        where: {
          id,
          ...(ctx.orgId ? { orgId: ctx.orgId } : {}),
          ...(hasPerm(ctx.permissions, PERMISSIONS.SPEND_READ_ALL) ? {} : { userId: ctx.userId }),
        },
      });
      if (!row) return toolFail("not_found");
      return {
        result: {
          id: row.id,
          createdAt: row.createdAt.toISOString(),
          model: row.model,
          endpoint: row.endpoint,
          stream: row.stream,
          status: row.status,
          outcome: row.outcome,
          error: redactSecrets(row.error),
          latencyMs: row.latencyMs,
          provider: row.provider,
          upstreamModel: row.upstreamModel,
          deploymentId: row.deploymentId,
          keyId: row.keyId,
          userId: row.userId,
          memberId: row.memberId,
          teamId: row.teamId,
          orgId: row.orgId,
          projectId: row.projectId,
          promptTokens: row.promptTokens,
          completionTokens: row.completionTokens,
          cost: money(row.cost),
          piiMode: row.piiMode,
          piiInput: row.piiInput,
          piiOutput: row.piiOutput,
          contentSkip: row.contentSkip,
        },
      };
    },
  }),
};
