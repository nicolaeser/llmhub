import "server-only";

import prisma from "@/lib/db/prisma";
import { canManage, grantActor } from "@/lib/auth/grants";
import { requirePermission } from "@/lib/auth/guards";
import { effectivePermissions, PERMISSIONS } from "@/lib/auth/permissions";
import { assertPlatform, inCompany, keyVisibleTo } from "@/lib/auth/scope";
import { writeAudit } from "@/lib/audit";
import { forecastBudget, spendWindow } from "@/lib/usage/forecast";
import { resolveKeyTenancy } from "@/lib/gateway/access/key-tenancy";
import { parseBudgetDurationMs } from "@/lib/gateway/billing/period";
import { patchEnterprise } from "@/lib/settings/enterprise";
import { budgetAmount, budgetPeriod, capConflict, MAX_BOOST_HOURS } from "@/lib/utils/budget";
import { money } from "@/lib/utils/money";
import type { AuthenticatedSession } from "@/types/auth";
import type { SpendHolder } from "@/types/billing";
import type {
  BoostInput,
  BudgetDetail,
  BudgetInput,
  BudgetKind,
  BudgetRef,
  BudgetResult,
  BudgetView,
  CapLink,
  HolderRecord,
} from "@/types/structure";

const BUDGET_KINDS: readonly string[] = ["org", "team", "project", "member", "user", "key"];
const PLATFORM_BUDGETS: readonly BudgetKind[] = ["org", "user"];

export const HOLDER = {
  id: true,
  spend: true,
  maxBudget: true,
  budgetDuration: true,
  spendResetAt: true,
  createdAt: true,
} as const;

function isBudgetKind(value: unknown): value is BudgetKind {
  return typeof value === "string" && BUDGET_KINDS.includes(value);
}

export function budgetView(
  row: SpendHolder,
  boosts: { id: string; amount: number; until: Date }[],
  now: Date,
): BudgetView {
  const spend = money(row.spend);
  const maxBudget = money(row.maxBudget);
  const boost = boosts.reduce((sum, item) => sum + item.amount, 0);
  const window = spendWindow(row, now);
  const forecast = forecastBudget(
    spend,
    maxBudget > 0 ? maxBudget + boost : 0,
    window.elapsedDays,
    window.remainingDays,
  );
  const windowMs = parseBudgetDurationMs(row.budgetDuration);
  return {
    maxBudget,
    spend,
    budgetDuration: row.budgetDuration,
    boost,
    boosts: boosts.map((item) => ({
      id: item.id,
      amount: item.amount,
      until: item.until.toISOString(),
    })),
    resetsAt:
      windowMs == null
        ? null
        : new Date((row.spendResetAt ?? row.createdAt).getTime() + windowMs).toISOString(),
    projectedMonth: forecast.projectedMonth,
    daysToExhaust: forecast.daysToExhaust,
    pctUsed: forecast.pctUsed,
  };
}

async function activeBoosts(kind: BudgetKind, id: string, now: Date) {
  const rows = await prisma.tempBudget.findMany({
    where: { entityType: kind, entityId: id, until: { gt: now } },
    orderBy: { until: "asc" },
  });
  return rows.map((row) => ({ id: row.id, amount: money(row.amount), until: row.until }));
}

async function holderRecord(
  session: AuthenticatedSession,
  kind: BudgetKind,
  id: string,
): Promise<HolderRecord | null> {
  const record = await loadHolderRecord(session, kind, id);
  return record && inCompany(session, record.orgId) ? record : null;
}

async function loadHolderRecord(
  session: AuthenticatedSession,
  kind: BudgetKind,
  id: string,
): Promise<HolderRecord | null> {
  if (kind === "org") {
    const row = await prisma.organization.findUnique({ where: { id } });
    return row ? { alias: row.alias, row, orgId: row.id, links: [] } : null;
  }
  if (kind === "team") {
    const row = await prisma.team.findUnique({ where: { id } });
    return row
      ? { alias: row.alias, row, orgId: row.orgId, links: [{ kind: "org", id: row.orgId }] }
      : null;
  }
  if (kind === "project") {
    const row = await prisma.project.findUnique({ where: { id } });
    return row
      ? {
          alias: row.alias,
          row,
          orgId: row.orgId,
          links: [
            { kind: "team", id: row.teamId },
            { kind: "org", id: row.orgId },
          ],
        }
      : null;
  }
  if (kind === "member") {
    const row = await prisma.member.findUnique({ where: { id } });
    return row
      ? {
          alias: row.name,
          row,
          orgId: row.orgId,
          links: [
            { kind: "team", id: row.teamId },
            { kind: "org", id: row.orgId },
          ],
        }
      : null;
  }
  if (kind === "user") {
    const row = await prisma.user.findUnique({
      where: { id },
      select: { ...HOLDER, username: true, orgId: true },
    });
    return row
      ? { alias: row.username, row, orgId: row.orgId, links: [{ kind: "org", id: row.orgId }] }
      : null;
  }
  const row = await prisma.virtualKey.findUnique({ where: { id } });
  if (!row || !keyVisibleTo(session, row)) return null;
  const { tenancy } = await resolveKeyTenancy(row);
  return {
    alias: row.keyAlias || row.prefix,
    row,
    orgId: row.orgId,
    links: [
      { kind: "user", id: tenancy.userId },
      { kind: "member", id: tenancy.memberId },
      { kind: "project", id: tenancy.projectId },
      { kind: "team", id: tenancy.teamId },
      { kind: "org", id: tenancy.orgId },
    ],
  };
}

async function capLink(
  session: AuthenticatedSession,
  kind: BudgetKind,
  id: string | null,
  now: Date,
): Promise<CapLink | null> {
  if (!id) return null;
  const found = await holderRecord(session, kind, id);
  if (!found) return null;
  const boosts = await activeBoosts(kind, id, now);
  return {
    kind,
    id,
    alias: found.alias,
    cap: money(found.row.maxBudget),
    boost: boosts.reduce((sum, item) => sum + item.amount, 0),
    spend: money(found.row.spend),
  };
}

async function ancestorsOf(
  session: AuthenticatedSession,
  record: HolderRecord,
  now: Date,
): Promise<CapLink[]> {
  const links = await Promise.all(record.links.map((link) => capLink(session, link.kind, link.id, now)));
  return links.filter((link): link is CapLink => link !== null);
}

async function budgetResult(
  session: AuthenticatedSession,
  kind: BudgetKind,
  id: string,
): Promise<BudgetResult> {
  const now = new Date();
  const record = await holderRecord(session, kind, id);
  if (!record) throw new Error("NOT_FOUND");
  return { kind, id, budget: budgetView(record.row, await activeBoosts(kind, id, now), now) };
}

async function writeBudget(
  kind: BudgetKind,
  id: string,
  data: { maxBudget: number; budgetDuration: string; spendResetAt?: Date },
) {
  if (kind === "org") await prisma.organization.update({ where: { id }, data });
  else if (kind === "team") await prisma.team.update({ where: { id }, data });
  else if (kind === "project") await prisma.project.update({ where: { id }, data });
  else if (kind === "member") await prisma.member.update({ where: { id }, data });
  else if (kind === "user") await prisma.user.update({ where: { id }, data });
  else await prisma.virtualKey.update({ where: { id }, data });
}

function assertBudgetScope(session: AuthenticatedSession, kind: BudgetKind) {
  if (PLATFORM_BUDGETS.includes(kind)) assertPlatform(session);
}

async function assertHolderManageable(session: AuthenticatedSession, kind: BudgetKind, id: string) {
  if (kind !== "user" || session.isOwner) return;
  const target = await prisma.user.findUnique({
    where: { id },
    select: { id: true, isOwner: true, orgId: true, role: { select: { permissions: true } } },
  });
  if (!target) throw new Error("NOT_FOUND");
  const permissions = effectivePermissions({
    isOwner: target.isOwner,
    rolePermissions: target.role?.permissions ?? [],
    orgId: target.orgId,
  });
  if (target.id === session.user.id || target.isOwner || !canManage(grantActor(session), permissions)) {
    throw new Error("FORBIDDEN");
  }
}

export async function loadBudget(input: BudgetRef): Promise<BudgetDetail> {
  const session = await requirePermission(PERMISSIONS.BUDGETS_MANAGE);
  if (!isBudgetKind(input.kind)) throw new Error("UNKNOWN_ENTITY_TYPE");
  assertBudgetScope(session, input.kind);
  const id = input.id?.trim();
  if (!id) throw new Error("MISSING_ID");
  const record = await holderRecord(session, input.kind, id);
  if (!record) throw new Error("NOT_FOUND");
  await assertHolderManageable(session, input.kind, id);
  const now = new Date();
  const [boosts, ancestors] = await Promise.all([
    activeBoosts(input.kind, id, now),
    ancestorsOf(session, record, now),
  ]);
  return { kind: input.kind, id, budget: budgetView(record.row, boosts, now), ancestors };
}

export async function setBudget(input: BudgetInput) {
  const session = await requirePermission(PERMISSIONS.BUDGETS_MANAGE);
  if (!isBudgetKind(input.kind)) throw new Error("UNKNOWN_ENTITY_TYPE");
  assertBudgetScope(session, input.kind);
  const id = input.id?.trim();
  if (!id) throw new Error("MISSING_ID");
  const maxBudget = budgetAmount(input.maxBudget);
  const budgetDuration = budgetPeriod(String(input.budgetDuration ?? ""));
  if (maxBudget == null || budgetDuration == null) throw new Error("VALIDATION");
  const now = new Date();
  const record = await holderRecord(session, input.kind, id);
  if (!record) throw new Error("NOT_FOUND");
  await assertHolderManageable(session, input.kind, id);
  if (capConflict(maxBudget, await ancestorsOf(session, record, now))) {
    throw new Error("BUDGET_EXCEEDS_PARENT");
  }
  const periodChanged = budgetDuration !== record.row.budgetDuration;
  await writeBudget(input.kind, id, {
    maxBudget,
    budgetDuration,
    ...(periodChanged ? { spendResetAt: now } : {}),
  });
  await writeAudit({
    actor: session.user.id,
    action: "budget.update",
    objectType: input.kind,
    objectId: id,
    before: { maxBudget: money(record.row.maxBudget), budgetDuration: record.row.budgetDuration },
    after: { maxBudget, budgetDuration },
  });
  return budgetResult(session, input.kind, id);
}

export async function addBoost(input: BoostInput) {
  const session = await requirePermission(PERMISSIONS.BUDGETS_MANAGE);
  if (!isBudgetKind(input.kind)) throw new Error("UNKNOWN_ENTITY_TYPE");
  assertBudgetScope(session, input.kind);
  const id = input.id?.trim();
  if (!id) throw new Error("MISSING_ID");
  const amount = budgetAmount(input.amount);
  const hours = Number(input.hours);
  if (!amount || !Number.isInteger(hours) || hours < 1 || hours > MAX_BOOST_HOURS) {
    throw new Error("VALIDATION");
  }
  const record = await holderRecord(session, input.kind, id);
  if (!record) throw new Error("NOT_FOUND");
  await assertHolderManageable(session, input.kind, id);
  if (!(money(record.row.maxBudget) > 0)) throw new Error("BUDGET_NOT_CAPPED");
  const until = new Date(Date.now() + hours * 3_600_000);
  await prisma.tempBudget.create({
    data: { entityType: input.kind, entityId: id, amount, until },
  });
  await writeAudit({
    actor: session.user.id,
    action: "budget.temp",
    objectType: input.kind,
    objectId: id,
    after: { amount, hours },
  });
  return budgetResult(session, input.kind, id);
}

export async function removeBoost(boostId: string, kind?: BudgetKind) {
  const session = await requirePermission(PERMISSIONS.BUDGETS_MANAGE);
  if (!boostId) throw new Error("MISSING_ID");
  const boost = await prisma.tempBudget.findUnique({ where: { id: boostId } });
  if (!boost || !isBudgetKind(boost.entityType) || (kind && boost.entityType !== kind)) {
    throw new Error("NOT_FOUND");
  }
  assertBudgetScope(session, boost.entityType);
  if (!(await holderRecord(session, boost.entityType, boost.entityId))) {
    throw new Error("NOT_FOUND");
  }
  await assertHolderManageable(session, boost.entityType, boost.entityId);
  await prisma.tempBudget.delete({ where: { id: boost.id } });
  await writeAudit({
    actor: session.user.id,
    action: "budget.temp.remove",
    objectType: boost.entityType,
    objectId: boost.entityId,
    before: { amount: money(boost.amount), until: boost.until.toISOString() },
  });
  return budgetResult(session, boost.entityType, boost.entityId);
}

export async function saveBudgetAlerts(thresholds: number[]) {
  const session = await requirePermission(PERMISSIONS.BUDGETS_MANAGE);
  assertPlatform(session);
  const cleaned = [
    ...new Set(
      (Array.isArray(thresholds) ? thresholds : [])
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0 && n <= 100),
    ),
  ].sort((a, b) => a - b);
  const budget_alert_thresholds = cleaned.length ? cleaned : [50, 80, 100];
  await patchEnterprise({ budget_alert_thresholds });
  await writeAudit({
    actor: session.user.id,
    action: "budget.alerts",
    objectType: "enterprise",
    objectId: "enterprise",
    after: { budget_alert_thresholds },
  });
  return { thresholds: budget_alert_thresholds };
}
