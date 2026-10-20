import "server-only";

import prisma from "@/lib/db/prisma";
import { requirePlatformPermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { writeAudit } from "@/lib/audit";
import { markupColumns, markupRuleOf } from "@/lib/gateway/billing/markup-policy";
import { marginTotals } from "@/lib/usage/usage-totals";
import { markupSchema } from "@/schemas/pricing";
import type { Prisma } from "@/generated/prisma/client";
import type { MarkupScope, MarkupView } from "@/types/pricing";

const MARGIN_WINDOW_DAYS = 30;

const markupSelect = {
  id: true,
  orgId: true,
  teamId: true,
  projectId: true,
  model: true,
  percent: true,
  note: true,
  updatedAt: true,
} as const;

type MarkupRow = Prisma.PriceMarkupGetPayload<{ select: typeof markupSelect }>;

function toMarkupView(row: MarkupRow): MarkupView {
  return { ...markupRuleOf(row), note: row.note, updatedAt: row.updatedAt.toISOString() };
}

function auditState(row: MarkupRow) {
  const view = toMarkupView(row);
  return { scope: view.scope, targetId: view.targetId, model: view.model, percent: view.percent, note: view.note };
}

async function targetExists(scope: MarkupScope, id: string): Promise<boolean> {
  const where = { where: { id }, select: { id: true } };
  switch (scope) {
    case "all":
      return true;
    case "org":
      return Boolean(await prisma.organization.findUnique(where));
    case "team":
      return Boolean(await prisma.team.findUnique(where));
    case "project":
      return Boolean(await prisma.project.findUnique(where));
  }
}

export async function loadMarkups() {
  const session = await requirePlatformPermission(PERMISSIONS.PRICING_READ);
  const [markups, orgs, teams, projects, groups, totals] = await Promise.all([
    prisma.priceMarkup.findMany({ orderBy: { createdAt: "asc" }, select: markupSelect }),
    prisma.organization.findMany({ orderBy: { alias: "asc" }, select: { id: true, alias: true } }),
    prisma.team.findMany({ orderBy: { alias: "asc" }, select: { id: true, alias: true, orgId: true } }),
    prisma.project.findMany({
      orderBy: { alias: "asc" },
      select: { id: true, alias: true, orgId: true, teamId: true },
    }),
    prisma.modelGroup.findMany({ orderBy: { alias: "asc" }, select: { alias: true } }),
    marginTotals(MARGIN_WINDOW_DAYS),
  ]);
  return {
    markups: markups.map(toMarkupView),
    orgs,
    teams: teams.map((row) => ({ id: row.id, alias: row.alias, orgId: row.orgId ?? "" })),
    projects: projects.map((row) => ({
      id: row.id,
      alias: row.alias,
      orgId: row.orgId ?? "",
      teamId: row.teamId ?? "",
    })),
    models: groups.map((group) => group.alias),
    totals,
    windowDays: MARGIN_WINDOW_DAYS,
    canManage: hasPerm(session.permissions, PERMISSIONS.PRICING_MANAGE),
  };
}

export async function saveMarkup(raw: unknown) {
  const session = await requirePlatformPermission(PERMISSIONS.PRICING_MANAGE);
  const parsed = markupSchema.safeParse(raw);
  if (!parsed.success) throw new Error("VALIDATION");
  const input = parsed.data;
  if (!(await targetExists(input.scope, input.targetId))) throw new Error("MARKUP_TARGET_NOT_FOUND");
  const columns = markupColumns(input.scope, input.targetId);
  const data = { ...columns, model: input.model, percent: input.percent, note: input.note };
  const result = await prisma.$transaction(
    async (tx) => {
      const before = input.id
        ? await tx.priceMarkup.findUnique({ where: { id: input.id }, select: markupSelect })
        : null;
      if (input.id && !before) throw new Error("NOT_FOUND");
      const taken = await tx.priceMarkup.count({
        where: { ...columns, model: input.model, ...(input.id ? { id: { not: input.id } } : {}) },
      });
      if (taken) throw new Error("MARKUP_EXISTS");
      const row = input.id
        ? await tx.priceMarkup.update({ where: { id: input.id }, data, select: markupSelect })
        : await tx.priceMarkup.create({ data, select: markupSelect });
      return { before, row };
    },
    { isolationLevel: "Serializable" },
  );
  await writeAudit({
    actor: session.user.id,
    action: result.before ? "markup.update" : "markup.create",
    objectType: "markup",
    objectId: result.row.id,
    before: result.before ? auditState(result.before) : undefined,
    after: auditState(result.row),
  });
  return { markup: toMarkupView(result.row) };
}

export async function deleteMarkup(id: string) {
  const session = await requirePlatformPermission(PERMISSIONS.PRICING_MANAGE);
  if (!id) throw new Error("MISSING_ID");
  const existing = await prisma.priceMarkup.findUnique({ where: { id }, select: markupSelect });
  if (!existing) throw new Error("NOT_FOUND");
  await prisma.priceMarkup.delete({ where: { id } });
  await writeAudit({
    actor: session.user.id,
    action: "markup.delete",
    objectType: "markup",
    objectId: existing.id,
    before: auditState(existing),
  });
  return { id: existing.id };
}
