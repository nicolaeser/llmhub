import "server-only";

import prisma from "@/lib/db/prisma";
import { digest, randomToken } from "@/lib/crypto";
import { createKeySchema, updateKeySchema } from "@/schemas/keys";
import type { ZodType } from "zod";
import { requireActor, requirePermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { companyOf, inCompany, keyVisibleTo, setupLinks, spendScope } from "@/lib/auth/scope";
import { managesMcpRules } from "@/lib/mcp/scope";
import { keyReferences, listKeys, toKeyView } from "@/lib/keys/view";
import { readsTemplates } from "@/lib/models/templates";
import { alertKeyBlocked } from "@/lib/alerts/notify";
import { writeAudit } from "@/lib/audit";
import { usageTotals } from "@/lib/usage/usage-totals";
import { isInternalKey } from "@/lib/gateway/access/key-tenancy";
import { loadModelPolicies, templateRuleSelect } from "@/lib/gateway/access/model-access";
import { templateModels, templateRulesOf } from "@/lib/gateway/access/model-policy";
import type { AuthenticatedSession } from "@/types/auth";
import type { KeyChoices, KeyDetail, KeyTab } from "@/types/keys";

async function keyBinding(
  session: AuthenticatedSession,
  projectId: string,
  memberId: string,
  current: { projectId: string | null; memberId: string | null } | null = null,
) {
  if (projectId && memberId) throw new Error("KEY_BINDING_CONFLICT");
  const unchanged =
    current !== null && (current.projectId ?? "") === projectId && (current.memberId ?? "") === memberId;
  const bindsTenancy = Boolean(projectId || memberId || current?.projectId || current?.memberId);
  if (bindsTenancy && !unchanged && !hasPerm(session.permissions, PERMISSIONS.TENANCY_MANAGE)) {
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

export async function createKey(raw: unknown) {
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
      maxRequestCost: input.maxRequestCost,
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
}

export async function updateKey(raw: unknown) {
  const session = await requirePermission(PERMISSIONS.KEYS_MANAGE);
  const input = parseKeyInput(updateKeySchema, raw);
  const existing = await prisma.virtualKey.findUnique({ where: { id: input.id } });
  if (!existing || !keyVisibleTo(session, existing)) throw new Error("NOT_FOUND");
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
    maxRequestCost: input.maxRequestCost,
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
}

export async function rotateKey(id: string) {
  const session = await requirePermission(PERMISSIONS.KEYS_MANAGE);
  if (!id) throw new Error("MISSING_ID");
  const existing = await prisma.virtualKey.findUnique({ where: { id } });
  if (!existing || !keyVisibleTo(session, existing)) {
    throw new Error("NOT_FOUND");
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
}

export async function revokeKey(id: string) {
  const session = await requirePermission(PERMISSIONS.KEYS_MANAGE);
  if (!id) throw new Error("MISSING_ID");
  const existing = await prisma.virtualKey.findUnique({ where: { id } });
  if (!existing || !keyVisibleTo(session, existing)) {
    throw new Error("NOT_FOUND");
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
}

export async function loadKeyTabs(): Promise<KeyTab[]> {
  const session = await requireActor();
  const tabs: KeyTab[] = [];
  if (hasPerm(session.permissions, PERMISSIONS.KEYS_READ)) tabs.push("keys");
  if (readsTemplates(session)) tabs.push("templates");
  return tabs;
}

export async function keyOptions(session: AuthenticatedSession): Promise<KeyChoices> {
  const [policies, templates] = await Promise.all([
    loadModelPolicies(),
    prisma.modelTemplate.findMany({
      orderBy: { name: "asc" },
      select: { ...templateRuleSelect, name: true, description: true },
    }),
  ]);
  return {
    models: policies.map((policy) => policy.alias),
    templates: templates.map((template) => ({
      id: template.id,
      name: template.name,
      description: template.description,
      matches: templateModels(templateRulesOf(template), policies),
    })),
    canTemplates: readsTemplates(session),
  };
}

export async function loadKeyOptions(): Promise<KeyChoices> {
  return keyOptions(await requirePermission(PERMISSIONS.KEYS_MANAGE));
}

export async function loadKeyDetail(id: string): Promise<KeyDetail> {
  const session = await requirePermission(PERMISSIONS.KEYS_READ);
  if (typeof id !== "string" || !id.trim()) throw new Error("MISSING_ID");
  const row = await prisma.virtualKey.findUnique({
    where: { id: id.trim() },
    include: { templates: { select: { templateId: true, template: { select: { name: true } } } } },
  });
  if (!row || !keyVisibleTo(session, row)) throw new Error("NOT_FOUND");
  return {
    key: toKeyView(row),
    templates: row.templates
      .map((entry) => ({ id: entry.templateId, name: entry.template.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export async function loadKeysPage() {
  const session = await requirePermission(PERMISSIONS.KEYS_READ);
  const company = companyOf(session);
  const inScope = company ? { orgId: company } : {};
  const keys = await listKeys(session);
  const refs = keyReferences(keys, session.user.id);
  const seesTenancy =
    hasPerm(session.permissions, PERMISSIONS.TENANCY_READ) || hasPerm(session.permissions, PERMISSIONS.TENANCY_MANAGE);
  const referenced = (ids: string[]) => (seesTenancy ? {} : { id: { in: ids } });
  const [orgs, teams, projects, members, users, choices, providerCount, overview] = await Promise.all([
    prisma.organization.findMany({
      where: company ? { id: company } : referenced(refs.orgs),
      orderBy: { alias: "asc" },
      select: { id: true, alias: true },
    }),
    prisma.team.findMany({
      where: { ...inScope, ...referenced(refs.teams) },
      orderBy: { alias: "asc" },
      select: { id: true, alias: true, orgId: true },
    }),
    prisma.project.findMany({
      where: { ...inScope, ...referenced(refs.projects) },
      orderBy: { alias: "asc" },
      select: { id: true, alias: true, orgId: true, teamId: true },
    }),
    prisma.member.findMany({
      where: { ...inScope, ...referenced(refs.members) },
      orderBy: { name: "asc" },
      select: { id: true, name: true, orgId: true, teamId: true },
    }),
    prisma.user.findMany({ where: { ...inScope, id: { in: refs.users } }, select: { id: true, username: true } }),
    keyOptions(session),
    prisma.providerConnection.count(),
    hasPerm(session.permissions, PERMISSIONS.SPEND_READ) ? usageTotals(7, spendScope(session)) : null,
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
    ...choices,
    providers: providerCount,
    overview,
    selfId: session.user.id,
    canManage: hasPerm(session.permissions, PERMISSIONS.KEYS_MANAGE),
    canBind: hasPerm(session.permissions, PERMISSIONS.TENANCY_MANAGE),
    canBudget: hasPerm(session.permissions, PERMISSIONS.BUDGETS_MANAGE),
    canMcp: managesMcpRules(session, company ?? null),
    canOpenCompanies: hasPerm(session.permissions, PERMISSIONS.TENANCY_READ),
    setupLinks: setupLinks(session),
  };
}
