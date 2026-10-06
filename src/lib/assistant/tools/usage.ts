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

function compactRows(rows: SliceRow[], labels: Map<string, string>) {
  return rows.slice(0, TOP_ROWS).map((row) => ({
    id: row.name,
    label: labels.get(row.name) ?? row.name,
    spend: roundMoney(row.spend),
    requests: row.requests ?? 0,
    errors: row.errors ?? 0,
    promptTokens: row.prompt,
    completionTokens: row.completion,
  }));
}

async function usageLabels(ids: {
  keys: string[];
  users: string[];
  teams: string[];
  orgs: string[];
  projects: string[];
}) {
  const [keys, users, teams, orgs, projects] = await Promise.all([
    prisma.virtualKey.findMany({
      where: { id: { in: ids.keys } },
      select: { id: true, keyAlias: true, prefix: true },
    }),
    prisma.user.findMany({ where: { id: { in: ids.users } }, select: { id: true, username: true } }),
    prisma.team.findMany({ where: { id: { in: ids.teams } }, select: { id: true, alias: true } }),
    prisma.organization.findMany({ where: { id: { in: ids.orgs } }, select: { id: true, alias: true } }),
    prisma.project.findMany({ where: { id: { in: ids.projects } }, select: { id: true, alias: true } }),
  ]);
  return {
    keys: new Map(keys.map((row) => [row.id, row.keyAlias || row.prefix])),
    users: new Map(users.map((row) => [row.id, row.username])),
    teams: new Map(teams.map((row) => [row.id, row.alias])),
    orgs: new Map(orgs.map((row) => [row.id, row.alias])),
    projects: new Map(projects.map((row) => [row.id, row.alias])),
  };
}

const topIds = (rows: SliceRow[]) => rows.slice(0, TOP_ROWS).map((row) => row.name);

export const usageTools = {
  get_overview: defineTool({
    description: "Seven-day spend, request, and error counts plus setup totals.",
    input: emptyToolInput,
    run: async (_args, ctx) => {
      const [providers, models, keys, totals] = await Promise.all([
        prisma.providerConnection.count(),
        prisma.modelGroup.count(),
        prisma.virtualKey.count({ where: ownKeysWhere(ctx) }),
        usageTotals(7, hasPerm(ctx.permissions, PERMISSIONS.SPEND_READ_ALL) ? undefined : ctx.userId),
      ]);
      return { result: { providers, models, keys, ...totals } };
    },
  }),
  get_usage: defineTool({
    description:
      "Spend, tokens, requests, errors, latency, daily series, and top models, keys, users, teams, organizations, and projects for the last N days. Filters narrow the result. Operators without spend:read-all only see their own usage.",
    input: usageToolInput,
    run: async (args) =>
      viaAction(loadUsageAction(args), async (usage) => {
        const labels = await usageLabels({
          keys: topIds(usage.byKey),
          users: topIds(usage.byUser),
          teams: topIds(usage.byTeam),
          orgs: topIds(usage.byOrg),
          projects: topIds(usage.byProject),
        });
        return {
          result: {
            days: usage.days,
            filters: {
              model: usage.model,
              teamId: usage.teamId,
              orgId: usage.orgId,
              projectId: usage.projectId,
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
            byModel: compactRows(usage.byModel, new Map()),
            byKey: compactRows(usage.byKey, labels.keys),
            byUser: compactRows(usage.byUser, labels.users),
            byTeam: compactRows(usage.byTeam, labels.teams),
            byOrg: compactRows(usage.byOrg, labels.orgs),
            byProject: compactRows(usage.byProject, labels.projects),
          },
        };
      }),
  }),
  search_logs: defineTool({
    description:
      "Recent gateway requests, newest first, with ids, counts by status, outcome, provider, and upstream model, and the most common error messages. Metadata only, never prompts or responses. Defaults to the last 24 hours.",
    input: searchLogsToolInput,
    run: async (args, ctx) => ({ result: await searchLogs(parseLogSearch(args), ctx) }),
  }),
  usage_breakdown: defineTool({
    description:
      "Spend, requests, errors, 429s, tokens, and average latency from the daily usage rollup, grouped by model, team, organization, project, key, or user.",
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
