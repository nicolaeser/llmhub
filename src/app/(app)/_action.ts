"use server";

import prisma from "@/lib/db/prisma";
import { digest, randomToken } from "@/lib/crypto";
import { createKeySchema, updateKeySchema } from "@/schemas/keys";
import type { ZodType } from "zod";
import { requireAuth, requirePermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { companyOf, inCompany, keyVisibleTo, spendScope } from "@/lib/auth/scope";
import {
  chargebackRows,
  groupCache,
  groupRequestHealth,
  groupSpend,
  summarizeUsage,
  usageDays,
} from "@/lib/gateway/usage-stats";
import { actionFail, runAction } from "@/lib/http/action-result";
import { listKeys, toKeyView } from "@/app/(app)/_data";
import { alertKeyBlocked } from "@/lib/gateway/alerts";
import { writeAudit } from "@/lib/gateway/audit";
import { getEnterprise } from "@/lib/gateway/settings";
import { checkForUpdate } from "@/lib/updates/update-check";
import { p95Latency, usageNames, usageSlices, usageTotals } from "@/lib/gateway/usage-totals";
import { isInternalKey } from "@/lib/gateway/key-tenancy";
import { loadModelPolicies, templateRuleSelect } from "@/lib/gateway/model-access";
import { templateModels, templateRulesOf } from "@/lib/gateway/model-policy";
import type { UsageSlice } from "@/types/gateway";
import type { AuthenticatedSession } from "@/types/auth";

async function keyBinding(
  session: AuthenticatedSession,
  projectId: string,
  memberId: string,
  current: { projectId: string | null; memberId: string | null } | null = null,
) {
  if (projectId && memberId) throw new Error("KEY_BINDING_CONFLICT");
  const unchanged =
    current !== null && (current.projectId ?? "") === projectId && (current.memberId ?? "") === memberId;
  if ((projectId || memberId) && !unchanged && !hasPerm(session.permissions, PERMISSIONS.TENANCY_MANAGE)) {
    throw new Error("FORBIDDEN");
  }
  if (projectId) {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, orgId: true, teamId: true },
    });
    if (!project?.orgId || !inCompany(session, project.orgId)) throw new Error("PROJECT_NOT_FOUND");
    return { projectId: project.id, memberId: null, teamId: project.teamId, orgId: project.orgId };
  }
  if (memberId) {
    const member = await prisma.member.findUnique({
      where: { id: memberId },
      select: { id: true, orgId: true, teamId: true },
    });
    if (!member || !inCompany(session, member.orgId)) throw new Error("MEMBER_NOT_FOUND");
    return { projectId: null, memberId: member.id, teamId: member.teamId, orgId: member.orgId };
  }
  return null;
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
    const tenancy = (await keyBinding(session, input.projectId, input.memberId)) ?? {
      projectId: null,
      memberId: null,
      teamId: null,
      orgId: companyOf(session),
    };
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
        allowedEndpoints: input.allowedEndpoints,
        accessWindows: input.accessWindows,
        accessTimeZone: input.accessTimeZone,
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
        allowedEndpoints: input.allowedEndpoints,
        accessWindows: input.accessWindows,
        accessTimeZone: input.accessTimeZone,
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
    if (!existing || !keyVisibleTo(session, existing)) return actionFail("NOT_FOUND");
    const bound = await keyBinding(session, input.projectId, input.memberId, existing);
    const tenancy =
      bound ??
      (isInternalKey(existing)
        ? { projectId: null, memberId: null, teamId: null, orgId: existing.orgId }
        : { projectId: null, memberId: null, teamId: null, orgId: companyOf(session), userId: session.user.id });
    const templates = await keyTemplates(input.templateIds);
    const after = {
      keyAlias: input.alias,
      ...tenancy,
      models: input.models,
      rpmLimit: input.rpm,
      tpmLimit: input.tpm,
      allowedIps: input.allowedIps,
      allowedEndpoints: input.allowedEndpoints,
      accessWindows: input.accessWindows,
      accessTimeZone: input.accessTimeZone,
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
    if (row.blocked && !existing.blocked) {
      void alertKeyBlocked(row, session.user.username || session.user.email);
    }
    return { key: toKeyView(row) };
  });
}

export async function rotateKeyAction(id: string) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.KEYS_MANAGE);
    if (!id) return actionFail("MISSING_ID");
    const existing = await prisma.virtualKey.findUnique({ where: { id } });
    if (!existing || !keyVisibleTo(session, existing)) {
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
    if (!existing || !keyVisibleTo(session, existing)) {
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
    const company = companyOf(session);
    const inScope = company ? { orgId: company } : {};
    const [keys, orgs, teams, projects, members, users, policies, templates, providerCount, overview] =
      await Promise.all([
        listKeys(session),
        prisma.organization.findMany({
          where: company ? { id: company } : {},
          orderBy: { alias: "asc" },
          select: { id: true, alias: true },
        }),
        prisma.team.findMany({
          where: inScope,
          orderBy: { alias: "asc" },
          select: { id: true, alias: true, orgId: true },
        }),
        prisma.project.findMany({
          where: inScope,
          orderBy: { alias: "asc" },
          select: { id: true, alias: true, orgId: true, teamId: true },
        }),
        prisma.member.findMany({
          where: inScope,
          orderBy: { name: "asc" },
          select: { id: true, name: true, orgId: true, teamId: true },
        }),
        prisma.user.findMany({ where: inScope, select: { id: true, username: true } }),
        loadModelPolicies(),
        prisma.modelTemplate.findMany({
          orderBy: { name: "asc" },
          select: { ...templateRuleSelect, name: true, description: true },
        }),
        prisma.providerConnection.count(),
        usageTotals(7, spendScope(session)),
      ]);
    return {
      keys,
      companyId: company ?? "",
      orgs,
      teams: teams.map((row) => ({ id: row.id, alias: row.alias, orgId: row.orgId ?? "" })),
      projects: projects.map((row) => ({
        id: row.id,
        alias: row.alias,
        orgId: row.orgId ?? "",
        teamId: row.teamId ?? "",
      })),
      members: members.map((row) => ({
        id: row.id,
        alias: row.name,
        orgId: row.orgId,
        teamId: row.teamId ?? "",
      })),
      owners: Object.fromEntries(users.map((user) => [user.id, user.username])),
      models: policies.map((policy) => policy.alias),
      templates: templates.map((template) => ({
        id: template.id,
        name: template.name,
        description: template.description,
        matches: templateModels(templateRulesOf(template), policies),
      })),
      providers: providerCount,
      overview,
      selfId: session.user.id,
      canManage: hasPerm(session.permissions, PERMISSIONS.KEYS_MANAGE),
      canBind: hasPerm(session.permissions, PERMISSIONS.TENANCY_MANAGE),
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
        memberId?: string;
        keyId?: string;
        userId?: string;
      } = 14,
) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.SPEND_READ);
    const query = typeof input === "number" ? { days: input } : input;
    const text = (value: string | undefined) => (value ?? "").trim();
    const days = Math.min(366, Math.max(1, Math.trunc(query.days ?? 14) || 14));
    const model = text(query.model);
    const teamId = text(query.teamId);
    const orgId = text(query.orgId);
    const projectId = text(query.projectId);
    const memberId = text(query.memberId);
    const keyId = text(query.keyId);
    const userId = text(query.userId);
    const now = new Date();
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const since = new Date(today - (days - 1) * 86400000);
    const filters = {
      ...(model ? { model } : {}),
      ...(teamId ? { teamId } : {}),
      ...(orgId ? { orgId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(memberId ? { memberId } : {}),
      ...(keyId ? { keyId } : {}),
      ...(userId ? { userId } : {}),
      ...spendScope(session),
    };
    const [rows, p95] = await Promise.all([
      usageSlices({ ...filters, day: { gte: since } }),
      p95Latency({ ...filters, createdAt: { gte: since } }),
    ]);
    const summary = summarizeUsage(rows, usageDays(since, days));
    const distinct = (pick: (row: UsageSlice) => string) =>
      [...new Set(rows.map(pick).filter(Boolean))].sort();
    return {
      days,
      model,
      teamId,
      orgId,
      projectId,
      memberId,
      keyId,
      userId,
      names: await usageNames(rows),
      models: distinct((row) => row.model),
      teams: distinct((row) => row.teamId),
      orgs: distinct((row) => row.orgId),
      projects: distinct((row) => row.projectId),
      members: distinct((row) => row.memberId),
      keys: distinct((row) => row.keyId),
      users: distinct((row) => row.userId),
      spend: summary.spend,
      tokens: summary.tokens,
      count: summary.count,
      errors: summary.errors,
      rate429: summary.rate429,
      latency: summary.latency,
      p95Latency: p95,
      cacheRead: summary.cacheRead,
      cacheWrite: summary.cacheWrite,
      cacheSavings: summary.cacheSavings,
      cacheHitRate: summary.cacheHitRate,
      daily: summary.daily,
      byModel: groupSpend(rows, "model").slice(0, 12),
      byTeam: groupSpend(rows, "teamId").slice(0, 12),
      byOrg: groupSpend(rows, "orgId").slice(0, 12),
      byProject: groupSpend(rows, "projectId").slice(0, 12),
      byMember: groupSpend(rows, "memberId").slice(0, 12),
      byKey: groupSpend(rows, "keyId").slice(0, 12),
      byUser: groupSpend(rows, "userId").slice(0, 12),
      healthByModel: groupRequestHealth(rows, "model").slice(0, 12),
      healthByTeam: groupRequestHealth(rows, "teamId").slice(0, 12),
      cacheByProject: groupCache(rows, "projectId").slice(0, 12),
      chargeback: chargebackRows(rows),
    };
  });
}

export async function loadAliasesAction() {
  return runAction(async () => {
    await requirePermission(PERMISSIONS.PLAYGROUND_USE);
    const [models, providers] = await Promise.all([
      prisma.modelGroup.findMany({ where: { enabled: true }, select: { alias: true }, orderBy: { alias: "asc" } }),
      prisma.providerConnection.count(),
    ]);
    return { models: models.map((m) => m.alias), providers };
  });
}

export async function loadUpdateStatusAction() {
  return runAction(async () => {
    await requireAuth();
    return checkForUpdate((await getEnterprise()).update_check !== false);
  });
}
