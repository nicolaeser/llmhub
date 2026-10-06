"use server";

import prisma from "@/lib/db/prisma";
import { digest, randomToken } from "@/lib/crypto";
import { createKeySchema, updateKeySchema } from "@/schemas/keys";
import type { ZodType } from "zod";
import { requirePermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { keyVisibleTo, seesAllSpend } from "@/lib/auth/scope";
import {
  chargebackRows,
  groupRequestHealth,
  groupSpend,
  percentileIndex,
} from "@/lib/gateway/usage-stats";
import { actionFail, runAction } from "@/lib/http/action-result";
import { listKeys, toKeyView } from "@/app/(app)/_data";
import { writeAudit } from "@/lib/gateway/audit";
import { usageTotals } from "@/lib/gateway/usage-totals";
import { loadModelPolicies, templateRuleSelect } from "@/lib/gateway/model-access";
import { templateModels, templateRulesOf } from "@/lib/gateway/model-policy";
import { money } from "@/lib/utils/money";
import type { UsageSlice } from "@/types/gateway";
import type { AuthenticatedSession } from "@/types/auth";

async function keyTenancy(session: AuthenticatedSession, teamId: string, projectId: string) {
  const project = projectId
    ? await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, teamId: true } })
    : null;
  if (projectId && !project) throw new Error("PROJECT_NOT_FOUND");
  if (project?.teamId && teamId && project.teamId !== teamId) {
    throw new Error("PROJECT_TEAM_MISMATCH");
  }
  const wantedTeam = project?.teamId ?? teamId;
  const team = wantedTeam
    ? await prisma.team.findUnique({ where: { id: wantedTeam }, select: { id: true, orgId: true } })
    : null;
  if (wantedTeam && !team) throw new Error("TEAM_NOT_FOUND");
  if (
    team &&
    team.id !== session.user.teamId &&
    !hasPerm(session.permissions, PERMISSIONS.TENANCY_MANAGE)
  ) {
    throw new Error("TEAM_NOT_MEMBER");
  }
  return { teamId: team?.id ?? null, orgId: team?.orgId ?? null, projectId: project?.id ?? null };
}

function parseKeyInput<T>(schema: ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error("VALIDATION");
  return parsed.data;
}

const withTemplates = { templates: { select: { templateId: true } } } as const;

async function keyTemplates(ids: string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const found = await prisma.modelTemplate.count({ where: { id: { in: unique } } });
  if (found !== unique.length) throw new Error("TEMPLATE_NOT_FOUND");
  return unique;
}

export async function createKeyAction(raw: unknown) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.KEYS_MANAGE);
    const input = parseKeyInput(createKeySchema, raw);
    const tenancy = await keyTenancy(session, input.teamId, input.projectId);
    const templates = await keyTemplates(input.templateIds);
    const secret = `sk-hub-${randomToken()}`;
    const row = await prisma.virtualKey.create({
      data: {
        hash: digest(secret),
        prefix: secret.slice(0, 12),
        keyAlias: input.alias,
        userId: session.user.id,
        ...tenancy,
        models: input.models,
        templates: { create: templates.map((templateId) => ({ templateId })) },
        rpmLimit: input.rpm,
        tpmLimit: input.tpm,
        allowedIps: input.allowedIps,
        logContent: input.logContent,
        expiresAt: input.days ? new Date(Date.now() + input.days * 86400000) : null,
      },
      include: withTemplates,
    });
    await writeAudit({
      actor: session.user.id,
      action: "key.create",
      objectType: "key",
      objectId: row.id,
      after: {
        alias: row.keyAlias,
        ...tenancy,
        models: input.models,
        templateIds: templates,
        allowedIps: input.allowedIps,
        logContent: input.logContent,
      },
    });
    return { key: { ...toKeyView(row), key: secret } };
  });
}

export async function updateKeyAction(raw: unknown) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.KEYS_MANAGE);
    const input = parseKeyInput(updateKeySchema, raw);
    const existing = await prisma.virtualKey.findUnique({ where: { id: input.id } });
    if (!existing || !keyVisibleTo(session, existing.userId)) return actionFail("NOT_FOUND");
    const tenancy = await keyTenancy(session, input.teamId, input.projectId);
    const templates = await keyTemplates(input.templateIds);
    const after = {
      keyAlias: input.alias,
      ...tenancy,
      models: input.models,
      rpmLimit: input.rpm,
      tpmLimit: input.tpm,
      allowedIps: input.allowedIps,
      logContent: input.logContent,
      blocked: input.blocked,
    };
    const row = await prisma.virtualKey.update({
      where: { id: input.id },
      data: {
        ...after,
        templates: { deleteMany: {}, create: templates.map((templateId) => ({ templateId })) },
      },
      include: withTemplates,
    });
    await writeAudit({
      actor: session.user.id,
      action: "key.update",
      objectType: "key",
      objectId: existing.id,
      after: { ...after, templateIds: templates },
    });
    return { key: toKeyView(row) };
  });
}

export async function rotateKeyAction(id: string) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.KEYS_MANAGE);
    if (!id) return actionFail("MISSING_ID");
    const existing = await prisma.virtualKey.findUnique({ where: { id } });
    if (!existing || !keyVisibleTo(session, existing.userId)) {
      return actionFail("NOT_FOUND");
    }
    const secret = `sk-hub-${randomToken()}`;
    const row = await prisma.virtualKey.update({
      where: { id },
      data: {
        prevHash: existing.hash,
        prevHashUntil: new Date(Date.now() + 60 * 60 * 1000),
        hash: digest(secret),
        prefix: secret.slice(0, 12),
      },
      include: withTemplates,
    });
    await writeAudit({
      actor: session.user.id,
      action: "key.rotate",
      objectType: "key",
      objectId: row.id,
      after: { prefix: row.prefix },
    });
    return { key: { ...toKeyView(row), key: secret } };
  });
}

export async function revokeKeyAction(id: string) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.KEYS_MANAGE);
    if (!id) return actionFail("MISSING_ID");
    const existing = await prisma.virtualKey.findUnique({ where: { id } });
    if (!existing || !keyVisibleTo(session, existing.userId)) {
      return actionFail("NOT_FOUND");
    }
    await prisma.virtualKey.delete({ where: { id } });
    await writeAudit({
      actor: session.user.id,
      action: "key.revoke",
      objectType: "key",
      objectId: existing.id,
      after: { alias: existing.keyAlias, prefix: existing.prefix },
    });
    return { id: existing.id };
  });
}

export async function loadKeysPageAction() {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.KEYS_READ);
    const anyTeam = hasPerm(session.permissions, PERMISSIONS.TENANCY_MANAGE);
    const ownTeam = anyTeam ? {} : { id: session.user.teamId ?? "" };
    const ownProjects = anyTeam
      ? {}
      : { OR: [{ teamId: null }, { teamId: session.user.teamId ?? "" }] };
    const [keys, teams, projects, policies, templates, providerCount, overview] = await Promise.all([
      listKeys(session),
      prisma.team.findMany({ where: ownTeam, orderBy: { alias: "asc" } }),
      prisma.project.findMany({
        where: ownProjects,
        orderBy: { alias: "asc" },
        select: { id: true, alias: true, teamId: true },
      }),
      loadModelPolicies(),
      prisma.modelTemplate.findMany({
        orderBy: { name: "asc" },
        select: { ...templateRuleSelect, name: true, description: true },
      }),
      prisma.providerConnection.count(),
      usageTotals(7, seesAllSpend(session) ? undefined : session.user.id),
    ]);
    return {
      keys,
      teams: teams.map((t) => ({ id: t.id, alias: t.alias })),
      projects,
      models: policies.map((policy) => policy.alias),
      templates: templates.map((template) => ({
        id: template.id,
        name: template.name,
        description: template.description,
        matches: templateModels(templateRulesOf(template), policies),
      })),
      providers: providerCount,
      overview,
      canBudget: hasPerm(session.permissions, PERMISSIONS.BUDGETS_MANAGE),
    };
  });
}

export async function loadUsageAction(
  input:
    | number
    | {
        days?: number;
        model?: string;
        teamId?: string;
        orgId?: string;
        projectId?: string;
        keyId?: string;
        userId?: string;
      } = 14,
) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.SPEND_READ);
    const days = Math.min(
      366,
      typeof input === "number"
        ? Math.max(1, Math.trunc(input) || 14)
        : Math.max(1, Math.trunc(input.days ?? 14) || 14),
    );
    const model =
      typeof input === "number" ? "" : (input.model ?? "").trim();
    const teamId = typeof input === "number" ? "" : (input.teamId ?? "").trim();
    const orgId = typeof input === "number" ? "" : (input.orgId ?? "").trim();
    const projectId =
      typeof input === "number" ? "" : (input.projectId ?? "").trim();
    const keyId = typeof input === "number" ? "" : (input.keyId ?? "").trim();
    const userId = typeof input === "number" ? "" : (input.userId ?? "").trim();
    const now = new Date();
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const since = new Date(today - (days - 1) * 86400000);
    const filters = {
      ...(seesAllSpend(session) ? {} : { userId: session.user.id }),
      ...(model ? { model } : {}),
      ...(teamId ? { teamId } : {}),
      ...(orgId ? { orgId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(keyId ? { keyId } : {}),
      ...(userId ? { userId } : {}),
    };
    const requestWhere = { ...filters, createdAt: { gte: since } };
    const [slices, logged] = await Promise.all([
      prisma.usageDaily.findMany({ where: { ...filters, day: { gte: since } } }),
      prisma.requestLog.count({ where: requestWhere }),
    ]);
    const p95Row = logged
      ? await prisma.requestLog.findFirst({
          where: requestWhere,
          orderBy: { latencyMs: "asc" },
          skip: percentileIndex(logged, 95),
          select: { latencyMs: true },
        })
      : null;
    const rows: UsageSlice[] = slices.map((row) => ({
      day: row.day.toISOString().slice(0, 10),
      keyId: row.keyId,
      teamId: row.teamId,
      orgId: row.orgId,
      projectId: row.projectId,
      userId: row.userId,
      model: row.model,
      requests: row.requests,
      errors: row.errors,
      rateLimited: row.rateLimited,
      latencyMs: Number(row.latencyMs),
      promptTokens: Number(row.promptTokens),
      completionTokens: Number(row.completionTokens),
      cost: money(row.cost),
    }));
    const daily = new Map<string, { spend: number; requests: number; errors: number }>();
    for (let i = days - 1; i >= 0; i--) {
      daily.set(new Date(today - i * 86400000).toISOString().slice(0, 10), {
        spend: 0,
        requests: 0,
        errors: 0,
      });
    }
    const totals = { spend: 0, tokens: 0, count: 0, errors: 0, rate429: 0, latencySum: 0 };
    for (const row of rows) {
      const bucket = daily.get(row.day);
      if (bucket) {
        bucket.spend += row.cost;
        bucket.requests += row.requests;
        bucket.errors += row.errors;
      }
      totals.spend += row.cost;
      totals.tokens += row.promptTokens + row.completionTokens;
      totals.count += row.requests;
      totals.errors += row.errors;
      totals.rate429 += row.rateLimited;
      totals.latencySum += row.latencyMs;
    }
    const distinct = (pick: (row: UsageSlice) => string) =>
      [...new Set(rows.map(pick).filter(Boolean))].sort();
    return {
      days,
      model,
      teamId,
      orgId,
      projectId,
      keyId,
      userId,
      models: distinct((row) => row.model),
      teams: distinct((row) => row.teamId),
      orgs: distinct((row) => row.orgId),
      projects: distinct((row) => row.projectId),
      keys: distinct((row) => row.keyId),
      users: distinct((row) => row.userId),
      spend: totals.spend,
      tokens: totals.tokens,
      count: totals.count,
      errors: totals.errors,
      rate429: totals.rate429,
      latency: totals.count ? totals.latencySum / totals.count : 0,
      p95Latency: p95Row?.latencyMs ?? 0,
      daily: [...daily.entries()].map(([day, v]) => ({ day, ...v })),
      byModel: groupSpend(rows, "model").slice(0, 12),
      byTeam: groupSpend(rows, "teamId").slice(0, 12),
      byOrg: groupSpend(rows, "orgId").slice(0, 12),
      byProject: groupSpend(rows, "projectId").slice(0, 12),
      byKey: groupSpend(rows, "keyId").slice(0, 12),
      byUser: groupSpend(rows, "userId").slice(0, 12),
      healthByModel: groupRequestHealth(rows, "model").slice(0, 12),
      healthByTeam: groupRequestHealth(rows, "teamId").slice(0, 12),
      chargeback: chargebackRows(rows),
    };
  });
}

export async function loadAliasesAction() {
  return runAction(async () => {
    await requirePermission(PERMISSIONS.PLAYGROUND_USE);
    const [models, providers] = await Promise.all([
      prisma.modelGroup.findMany({ select: { alias: true } }),
      prisma.providerConnection.count(),
    ]);
    return { models: models.map((m) => m.alias), providers };
  });
}
