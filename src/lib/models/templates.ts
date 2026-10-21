import "server-only";

import prisma from "@/lib/db/prisma";
import { requirePlatformPermission } from "@/lib/auth/guards";
import { isPrismaCode } from "@/lib/auth/errors";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { companyOf } from "@/lib/auth/scope";
import { writeAudit } from "@/lib/audit";
import { loadModelPolicies, templateRuleSelect } from "@/lib/gateway/access/model-access";
import { hasRules, templateRulesOf } from "@/lib/gateway/access/model-policy";
import { createTemplateSchema, updateTemplateSchema } from "@/schemas/model-templates";
import type { ZodType } from "zod";
import type { AuthenticatedSession } from "@/types/auth";
import type { ModelTemplateView, TemplateRules } from "@/types/model-templates";

const templateSelect = {
  ...templateRuleSelect,
  name: true,
  description: true,
  _count: { select: { keys: true } },
} as const;

function toTemplateView(row: Parameters<typeof templateRulesOf>[0] & {
  id: string;
  name: string;
  description: string;
  _count: { keys: number };
}): ModelTemplateView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    keyCount: row._count.keys,
    ...templateRulesOf(row),
  };
}

function parseTemplate<T extends TemplateRules>(schema: ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error("VALIDATION");
  const input = parsed.data;
  if (!input.models.length && !hasRules(input)) throw new Error("TEMPLATE_EMPTY");
  return {
    ...input,
    models: [...new Set(input.models)],
    patterns: [...new Set(input.patterns)],
    providerIds: [...new Set(input.providerIds)],
    regions: [...new Set(input.regions)],
  };
}

async function assertProviders(ids: string[]) {
  if (!ids.length) return;
  const found = await prisma.providerConnection.count({ where: { id: { in: ids } } });
  if (found !== ids.length) throw new Error("NOT_FOUND");
}

function templateData(input: TemplateRules & { name: string; description: string }) {
  return {
    name: input.name,
    description: input.description,
    models: input.models,
    patterns: input.patterns,
    providerIds: input.providerIds,
    regions: input.regions,
    zdrOnly: input.zdrOnly,
    noTrainingOnly: input.noTrainingOnly,
    maxRetentionDays: input.maxRetentionDays,
  };
}

async function saveTemplate<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isPrismaCode(error, "P2002")) throw new Error("NAME_EXISTS", { cause: error });
    throw error;
  }
}

export function readsTemplates(session: AuthenticatedSession): boolean {
  return hasPerm(session.permissions, PERMISSIONS.MODELS_READ) && !companyOf(session);
}

export async function loadTemplates() {
  const session = await requirePlatformPermission(PERMISSIONS.MODELS_READ);
  const [templates, policies, providers] = await Promise.all([
    prisma.modelTemplate.findMany({ orderBy: { name: "asc" }, select: templateSelect }),
    loadModelPolicies(),
    prisma.providerConnection.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, kind: true },
    }),
  ]);
  return {
    templates: templates.map(toTemplateView),
    policies,
    providers,
    canManage: hasPerm(session.permissions, PERMISSIONS.MODELS_MANAGE),
  };
}

export async function createTemplate(raw: unknown) {
  const session = await requirePlatformPermission(PERMISSIONS.MODELS_MANAGE);
  const input = parseTemplate(createTemplateSchema, raw);
  await assertProviders(input.providerIds);
  const row = await saveTemplate(() =>
    prisma.modelTemplate.create({ data: templateData(input), select: templateSelect }),
  );
  await writeAudit({
    actor: session.user.id,
    action: "template.create",
    objectType: "template",
    objectId: row.id,
    after: templateData(input),
  });
  return { template: toTemplateView(row) };
}

export async function updateTemplate(raw: unknown) {
  const session = await requirePlatformPermission(PERMISSIONS.MODELS_MANAGE);
  const input = parseTemplate(updateTemplateSchema, raw);
  const existing = await prisma.modelTemplate.findUnique({ where: { id: input.id }, select: templateSelect });
  if (!existing) throw new Error("NOT_FOUND");
  await assertProviders(input.providerIds);
  const row = await saveTemplate(() =>
    prisma.modelTemplate.update({
      where: { id: input.id },
      data: templateData(input),
      select: templateSelect,
    }),
  );
  await writeAudit({
    actor: session.user.id,
    action: "template.update",
    objectType: "template",
    objectId: row.id,
    before: { name: existing.name, description: existing.description, ...templateRulesOf(existing) },
    after: templateData(input),
  });
  return { template: toTemplateView(row) };
}

export async function deleteTemplate(id: string) {
  const session = await requirePlatformPermission(PERMISSIONS.MODELS_MANAGE);
  if (!id) throw new Error("MISSING_ID");
  const existing = await prisma.modelTemplate.findUnique({ where: { id }, select: templateSelect });
  if (!existing) throw new Error("NOT_FOUND");
  if (existing._count.keys > 0) throw new Error("TEMPLATE_IN_USE");
  try {
    await prisma.modelTemplate.delete({ where: { id } });
  } catch (error) {
    if (isPrismaCode(error, "P2003")) throw new Error("TEMPLATE_IN_USE", { cause: error });
    throw error;
  }
  await writeAudit({
    actor: session.user.id,
    action: "template.delete",
    objectType: "template",
    objectId: existing.id,
    before: { name: existing.name, description: existing.description, ...templateRulesOf(existing) },
  });
  return { id: existing.id };
}
