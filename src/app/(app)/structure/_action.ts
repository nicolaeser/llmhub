"use server";

import prisma from "@/lib/db/prisma";
import { requirePermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { keyVisibleTo, seesAllResources } from "@/lib/auth/scope";
import { writeAudit } from "@/lib/gateway/audit";
import { forecastBudget, spendWindow } from "@/lib/gateway/forecast";
import { parseBudgetDurationMs } from "@/lib/gateway/period";
import { getEnterprise, patchEnterprise } from "@/lib/gateway/settings";
import { actionFail, runAction } from "@/lib/http/action-result";
import { budgetAmount, budgetPeriod, capConflict, MAX_BOOST_HOURS } from "@/lib/utils/budget";
import { money } from "@/lib/utils/money";
import type { AuthenticatedSession, Permission } from "@/types/auth";
import type { SpendHolder } from "@/types/gateway";
import type {
  BoostInput,
  BudgetInput,
  BudgetKind,
  BudgetResult,
  BudgetView,
  CapLink,
  HolderRecord,
  NodeKind,
  StructurePayload,
} from "@/types/structure";

const BUDGET_KINDS: readonly string[] = ["org", "team", "project", "user", "key"];
const NODE_KINDS: readonly string[] = ["org", "team", "project"];
const HOLDER = {
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

function isNodeKind(value: unknown): value is NodeKind {
  return typeof value === "string" && NODE_KINDS.includes(value);
}

function cleanAlias(value: unknown): string {
  const alias = typeof value === "string" ? value.trim() : "";
  if (!alias) throw new Error("ALIAS_REQUIRED");
  if (alias.length > 80) throw new Error("VALIDATION");
  return alias;
}

function cleanLimit(value: unknown, max: number): number {
  const n = Number(value ?? 0);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new Error("VALIDATION");
  return n;
}

function budgetView(
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

async function structurePayload(session: AuthenticatedSession): Promise<StructurePayload> {
  const now = new Date();
  const seesKeys = hasPerm(session.permissions, PERMISSIONS.KEYS_READ);
  const [orgs, teams, projects, users, keys, temps, enterprise] = await Promise.all([
    prisma.organization.findMany({ orderBy: { alias: "asc" } }),
    prisma.team.findMany({ orderBy: { alias: "asc" } }),
    prisma.project.findMany({ orderBy: { alias: "asc" } }),
    prisma.user.findMany({
      orderBy: { username: "asc" },
      select: { ...HOLDER, username: true, email: true, orgId: true, teamId: true, blocked: true },
    }),
    seesKeys
      ? prisma.virtualKey.findMany({
          where: seesAllResources(session) ? {} : { userId: session.user.id },
          orderBy: { keyAlias: "asc" },
        })
      : Promise.resolve([]),
    prisma.tempBudget.findMany({ where: { until: { gt: now } }, orderBy: { until: "asc" } }),
    getEnterprise(),
  ]);
  const boosts = (kind: BudgetKind, id: string) =>
    temps
      .filter((row) => row.entityType === kind && row.entityId === id)
      .map((row) => ({ id: row.id, amount: money(row.amount), until: row.until }));
  return {
    orgs: orgs.map((row) => ({
      id: row.id,
      alias: row.alias,
      budget: budgetView(row, boosts("org", row.id), now),
    })),
    teams: teams.map((row) => ({
      id: row.id,
      alias: row.alias,
      orgId: row.orgId ?? "",
      rpmLimit: row.rpmLimit,
      tpmLimit: row.tpmLimit,
      budget: budgetView(row, boosts("team", row.id), now),
    })),
    projects: projects.map((row) => ({
      id: row.id,
      alias: row.alias,
      teamId: row.teamId ?? "",
      owner: row.owner,
      budget: budgetView(row, boosts("project", row.id), now),
    })),
    users: users.map((row) => ({
      id: row.id,
      username: row.username,
      email: row.email,
      orgId: row.orgId ?? "",
      teamId: row.teamId ?? "",
      blocked: row.blocked,
      budget: budgetView(row, boosts("user", row.id), now),
    })),
    keys: keys.map((row) => ({
      id: row.id,
      alias: row.keyAlias || row.prefix,
      prefix: row.prefix,
      userId: row.userId ?? "",
      teamId: row.teamId ?? "",
      projectId: row.projectId ?? "",
      blocked: row.blocked,
      budget: budgetView(row, boosts("key", row.id), now),
    })),
    thresholds: enterprise.budget_alert_thresholds ?? [50, 80, 100],
    canManage: hasPerm(session.permissions, PERMISSIONS.TENANCY_MANAGE),
    canBudget: hasPerm(session.permissions, PERMISSIONS.BUDGETS_MANAGE),
  };
}

async function mutate(
  permission: Permission,
  change: (session: AuthenticatedSession) => Promise<void>,
): Promise<StructurePayload> {
  const session = await requirePermission(permission);
  await change(session);
  return structurePayload(await requirePermission(PERMISSIONS.TENANCY_READ));
}

async function assertUniqueAlias(
  kind: NodeKind,
  alias: string,
  id: string | null,
  parentId: string | null,
) {
  const where = {
    alias: { equals: alias, mode: "insensitive" as const },
    ...(id ? { id: { not: id } } : {}),
  };
  const clash =
    kind === "org"
      ? await prisma.organization.findFirst({ where, select: { id: true } })
      : kind === "team"
        ? await prisma.team.findFirst({ where: { ...where, orgId: parentId }, select: { id: true } })
        : await prisma.project.findFirst({ where: { ...where, teamId: parentId }, select: { id: true } });
  if (clash) throw new Error("ALIAS_EXISTS");
}

export async function loadStructureAction() {
  return runAction(async () => structurePayload(await requirePermission(PERMISSIONS.TENANCY_READ)));
}

export async function saveOrgAction(input: { id?: string; alias: string }) {
  return runAction(() =>
    mutate(PERMISSIONS.TENANCY_MANAGE, async (session) => {
      const alias = cleanAlias(input.alias);
      const id = input.id?.trim() || null;
      const existing = id ? await prisma.organization.findUnique({ where: { id } }) : null;
      if (id && !existing) throw new Error("NOT_FOUND");
      await assertUniqueAlias("org", alias, id, null);
      const row = existing
        ? await prisma.organization.update({ where: { id: existing.id }, data: { alias } })
        : await prisma.organization.create({ data: { alias } });
      await writeAudit({
        actor: session.user.id,
        action: existing ? "org.update" : "org.create",
        objectType: "org",
        objectId: row.id,
        before: existing ? { alias: existing.alias } : undefined,
        after: { alias: row.alias },
      });
    }),
  );
}

export async function saveTeamAction(input: {
  id?: string;
  alias: string;
  orgId: string;
  rpm: number;
  tpm: number;
}) {
  return runAction(() =>
    mutate(PERMISSIONS.TENANCY_MANAGE, async (session) => {
      const alias = cleanAlias(input.alias);
      const id = input.id?.trim() || null;
      const orgId = input.orgId?.trim() || null;
      if (!orgId) throw new Error("ORG_REQUIRED");
      if (!(await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true } }))) {
        throw new Error("ORG_NOT_FOUND");
      }
      const existing = id ? await prisma.team.findUnique({ where: { id } }) : null;
      if (id && !existing) throw new Error("NOT_FOUND");
      await assertUniqueAlias("team", alias, id, orgId);
      const data = {
        alias,
        orgId,
        rpmLimit: cleanLimit(input.rpm, 1_000_000),
        tpmLimit: cleanLimit(input.tpm, 1_000_000_000),
      };
      const row = existing
        ? (
            await prisma.$transaction([
              prisma.team.update({ where: { id: existing.id }, data }),
              prisma.user.updateMany({ where: { teamId: existing.id }, data: { orgId } }),
              prisma.virtualKey.updateMany({ where: { teamId: existing.id }, data: { orgId } }),
            ])
          )[0]
        : await prisma.team.create({ data });
      await writeAudit({
        actor: session.user.id,
        action: existing ? "team.update" : "team.create",
        objectType: "team",
        objectId: row.id,
        before: existing
          ? {
              alias: existing.alias,
              orgId: existing.orgId,
              rpmLimit: existing.rpmLimit,
              tpmLimit: existing.tpmLimit,
            }
          : undefined,
        after: data,
      });
    }),
  );
}

export async function saveProjectAction(input: {
  id?: string;
  alias: string;
  teamId: string;
  owner: string;
}) {
  return runAction(() =>
    mutate(PERMISSIONS.TENANCY_MANAGE, async (session) => {
      const alias = cleanAlias(input.alias);
      const id = input.id?.trim() || null;
      const teamId = input.teamId?.trim() || null;
      if (!teamId) throw new Error("TEAM_REQUIRED");
      const team = await prisma.team.findUnique({
        where: { id: teamId },
        select: { id: true, orgId: true },
      });
      if (!team) throw new Error("TEAM_NOT_FOUND");
      const owner = typeof input.owner === "string" ? input.owner.trim() : "";
      if (owner.length > 200) throw new Error("VALIDATION");
      const existing = id ? await prisma.project.findUnique({ where: { id } }) : null;
      if (id && !existing) throw new Error("NOT_FOUND");
      await assertUniqueAlias("project", alias, id, teamId);
      const data = { alias, teamId, owner };
      const row = existing
        ? (
            await prisma.$transaction([
              prisma.project.update({ where: { id: existing.id }, data }),
              prisma.virtualKey.updateMany({
                where: { projectId: existing.id },
                data: { teamId, orgId: team.orgId },
              }),
            ])
          )[0]
        : await prisma.project.create({ data });
      await writeAudit({
        actor: session.user.id,
        action: existing ? "project.update" : "project.create",
        objectType: "project",
        objectId: row.id,
        before: existing
          ? { alias: existing.alias, teamId: existing.teamId, owner: existing.owner }
          : undefined,
        after: data,
      });
    }),
  );
}

export async function deleteNodeAction(input: { kind: NodeKind; id: string }) {
  return runAction(() =>
    mutate(PERMISSIONS.TENANCY_MANAGE, async (session) => {
      if (!isNodeKind(input.kind)) throw new Error("UNKNOWN_ENTITY_TYPE");
      const id = input.id?.trim();
      if (!id) throw new Error("MISSING_ID");
      const boosts = prisma.tempBudget.deleteMany({ where: { entityType: input.kind, entityId: id } });
      if (input.kind === "org") {
        const row = await prisma.organization.findUnique({ where: { id } });
        if (!row) throw new Error("NOT_FOUND");
        if (await prisma.team.count({ where: { orgId: id } })) throw new Error("HAS_CHILDREN");
        await prisma.$transaction([
          prisma.user.updateMany({ where: { orgId: id }, data: { orgId: null } }),
          prisma.organization.delete({ where: { id } }),
          boosts,
        ]);
        await writeAudit({
          actor: session.user.id,
          action: "org.delete",
          objectType: "org",
          objectId: id,
          before: { alias: row.alias },
        });
        return;
      }
      if (input.kind === "team") {
        const row = await prisma.team.findUnique({ where: { id } });
        if (!row) throw new Error("NOT_FOUND");
        if (await prisma.project.count({ where: { teamId: id } })) throw new Error("HAS_CHILDREN");
        await prisma.$transaction([
          prisma.virtualKey.updateMany({ where: { teamId: id }, data: { teamId: null, orgId: null } }),
          prisma.team.delete({ where: { id } }),
          boosts,
        ]);
        await writeAudit({
          actor: session.user.id,
          action: "team.delete",
          objectType: "team",
          objectId: id,
          before: { alias: row.alias, orgId: row.orgId },
        });
        return;
      }
      const row = await prisma.project.findUnique({ where: { id } });
      if (!row) throw new Error("NOT_FOUND");
      await prisma.$transaction([prisma.project.delete({ where: { id } }), boosts]);
      await writeAudit({
        actor: session.user.id,
        action: "project.delete",
        objectType: "project",
        objectId: id,
        before: { alias: row.alias, teamId: row.teamId, owner: row.owner },
      });
    }),
  );
}

export async function placeMemberAction(input: { userId: string; orgId: string; teamId: string }) {
  return runAction(() =>
    mutate(PERMISSIONS.TENANCY_MANAGE, async (session) => {
      const userId = input.userId?.trim();
      if (!userId) throw new Error("MISSING_ID");
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, orgId: true, teamId: true },
      });
      if (!user) throw new Error("USER_NOT_FOUND");
      const teamId = input.teamId?.trim() || null;
      const team = teamId
        ? await prisma.team.findUnique({ where: { id: teamId }, select: { id: true, orgId: true } })
        : null;
      if (teamId && !team) throw new Error("TEAM_NOT_FOUND");
      const wantedOrg = input.orgId?.trim() || null;
      if (team?.orgId && wantedOrg && team.orgId !== wantedOrg) throw new Error("VALIDATION");
      const orgId = team?.orgId ?? wantedOrg;
      if (orgId && !(await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true } }))) {
        throw new Error("ORG_NOT_FOUND");
      }
      const after = { orgId, teamId: team?.id ?? null };
      await prisma.user.update({
        where: { id: user.id },
        data: { ...after, revision: { increment: 1 } },
      });
      await writeAudit({
        actor: session.user.id,
        action: "member.place",
        objectType: "user",
        objectId: user.id,
        before: { orgId: user.orgId, teamId: user.teamId },
        after,
      });
    }),
  );
}

async function holderRecord(
  session: AuthenticatedSession,
  kind: BudgetKind,
  id: string,
): Promise<HolderRecord | null> {
  if (kind === "org") {
    const row = await prisma.organization.findUnique({ where: { id } });
    return row
      ? { alias: row.alias, row, userId: null, projectId: null, teamId: null, orgId: null }
      : null;
  }
  if (kind === "team") {
    const row = await prisma.team.findUnique({ where: { id } });
    return row
      ? { alias: row.alias, row, userId: null, projectId: null, teamId: null, orgId: row.orgId }
      : null;
  }
  if (kind === "project") {
    const row = await prisma.project.findUnique({ where: { id } });
    return row
      ? { alias: row.alias, row, userId: null, projectId: null, teamId: row.teamId, orgId: null }
      : null;
  }
  if (kind === "user") {
    const row = await prisma.user.findUnique({
      where: { id },
      select: { ...HOLDER, username: true, teamId: true, orgId: true },
    });
    return row
      ? { alias: row.username, row, userId: null, projectId: null, teamId: row.teamId, orgId: row.orgId }
      : null;
  }
  const row = await prisma.virtualKey.findUnique({ where: { id } });
  if (!row || !keyVisibleTo(session, row.userId)) return null;
  return {
    alias: row.keyAlias || row.prefix,
    row,
    userId: row.userId,
    projectId: row.projectId,
    teamId: row.teamId,
    orgId: row.orgId,
  };
}

async function capLink(
  session: AuthenticatedSession,
  kind: BudgetKind,
  id: string | null | undefined,
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
  kind: BudgetKind,
  record: HolderRecord,
  now: Date,
): Promise<CapLink[]> {
  const owner = record.userId
    ? await prisma.user.findUnique({
        where: { id: record.userId },
        select: { id: true, teamId: true, orgId: true },
      })
    : null;
  const project = record.projectId
    ? await prisma.project.findUnique({ where: { id: record.projectId }, select: { teamId: true } })
    : null;
  const bound = kind === "key" ? (project?.teamId ?? record.teamId) : record.teamId;
  const teamId = bound ?? (kind === "key" ? (owner?.teamId ?? null) : null);
  const team = teamId
    ? await prisma.team.findUnique({ where: { id: teamId }, select: { id: true, orgId: true } })
    : null;
  const orgId =
    kind === "team" ? record.orgId : (team?.orgId ?? (bound ? null : (owner?.orgId ?? record.orgId)));
  const links = await Promise.all([
    kind === "key" ? capLink(session, "user", owner?.id, now) : null,
    kind === "key" ? capLink(session, "project", record.projectId, now) : null,
    kind === "org" || kind === "team" ? null : capLink(session, "team", team?.id, now),
    kind === "org" ? null : capLink(session, "org", orgId, now),
  ]);
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
  else if (kind === "user") await prisma.user.update({ where: { id }, data });
  else await prisma.virtualKey.update({ where: { id }, data });
}

export async function setBudgetAction(input: BudgetInput) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.BUDGETS_MANAGE);
    if (!isBudgetKind(input.kind)) return actionFail("UNKNOWN_ENTITY_TYPE");
    const id = input.id?.trim();
    if (!id) return actionFail("MISSING_ID");
    const maxBudget = budgetAmount(input.maxBudget);
    const budgetDuration = budgetPeriod(String(input.budgetDuration ?? ""));
    if (maxBudget == null || budgetDuration == null) return actionFail("VALIDATION");
    const now = new Date();
    const record = await holderRecord(session, input.kind, id);
    if (!record) return actionFail("NOT_FOUND");
    if (capConflict(maxBudget, await ancestorsOf(session, input.kind, record, now))) {
      return actionFail("BUDGET_EXCEEDS_PARENT");
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
  });
}

export async function addBoostAction(input: BoostInput) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.BUDGETS_MANAGE);
    if (!isBudgetKind(input.kind)) return actionFail("UNKNOWN_ENTITY_TYPE");
    const id = input.id?.trim();
    if (!id) return actionFail("MISSING_ID");
    const amount = budgetAmount(input.amount);
    const hours = Number(input.hours);
    if (!amount || !Number.isInteger(hours) || hours < 1 || hours > MAX_BOOST_HOURS) {
      return actionFail("VALIDATION");
    }
    const record = await holderRecord(session, input.kind, id);
    if (!record) return actionFail("NOT_FOUND");
    if (!(money(record.row.maxBudget) > 0)) return actionFail("BUDGET_NOT_CAPPED");
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
  });
}

export async function removeBoostAction(boostId: string) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.BUDGETS_MANAGE);
    if (!boostId) return actionFail("MISSING_ID");
    const boost = await prisma.tempBudget.findUnique({ where: { id: boostId } });
    if (!boost || !isBudgetKind(boost.entityType)) return actionFail("NOT_FOUND");
    if (!(await holderRecord(session, boost.entityType, boost.entityId))) {
      return actionFail("NOT_FOUND");
    }
    await prisma.tempBudget.delete({ where: { id: boost.id } });
    await writeAudit({
      actor: session.user.id,
      action: "budget.temp.remove",
      objectType: boost.entityType,
      objectId: boost.entityId,
      before: { amount: money(boost.amount), until: boost.until.toISOString() },
    });
    return budgetResult(session, boost.entityType, boost.entityId);
  });
}

export async function saveBudgetAlertsAction(thresholds: number[]) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.BUDGETS_MANAGE);
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
  });
}
