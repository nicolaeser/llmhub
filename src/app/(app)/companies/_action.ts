"use server";

import prisma from "@/lib/db/prisma";
import { requirePermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { companyOf, inCompany, keyScope, keyVisibleTo } from "@/lib/auth/scope";
import { writeAudit } from "@/lib/gateway/audit";
import { forecastBudget, spendWindow } from "@/lib/gateway/forecast";
import { resolveKeyTenancy } from "@/lib/gateway/key-tenancy";
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
  MemberInput,
  NodeKind,
  ProjectInput,
  StructurePayload,
} from "@/types/structure";

const BUDGET_KINDS: readonly string[] = ["org", "team", "project", "member", "user", "key"];
const NODE_KINDS: readonly string[] = ["org", "team", "project", "member"];
const PLATFORM_BUDGETS: readonly BudgetKind[] = ["org", "user"];
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

function cleanEmail(value: unknown): string {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (email.length > 254 || (email && !email.includes("@"))) throw new Error("VALIDATION");
  return email;
}

function cleanText(value: unknown, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length > max) throw new Error("VALIDATION");
  return text;
}

function cleanLimit(value: unknown, max: number): number {
  const n = Number(value ?? 0);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new Error("VALIDATION");
  return n;
}

function assertPlatform(session: AuthenticatedSession) {
  if (companyOf(session)) throw new Error("PLATFORM_ONLY");
}

function assertInCompany(session: AuthenticatedSession, orgId: string | null | undefined) {
  if (!inCompany(session, orgId)) throw new Error("NOT_FOUND");
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
  const company = companyOf(session);
  const inScope = company ? { orgId: company } : {};
  const seesKeys = hasPerm(session.permissions, PERMISSIONS.KEYS_READ);
  const [orgs, teams, projects, members, users, keys, temps, enterprise] = await Promise.all([
    prisma.organization.findMany({ where: company ? { id: company } : {}, orderBy: { alias: "asc" } }),
    prisma.team.findMany({ where: inScope, orderBy: { alias: "asc" } }),
    prisma.project.findMany({ where: inScope, orderBy: { alias: "asc" } }),
    prisma.member.findMany({ where: inScope, orderBy: { name: "asc" } }),
    prisma.user.findMany({
      where: inScope,
      orderBy: { username: "asc" },
      select: { ...HOLDER, username: true, orgId: true },
    }),
    seesKeys
      ? prisma.virtualKey.findMany({ where: keyScope(session), orderBy: { keyAlias: "asc" } })
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
      orgId: row.orgId ?? "",
      teamId: row.teamId ?? "",
      owner: row.owner,
      budget: budgetView(row, boosts("project", row.id), now),
    })),
    members: members.map((row) => ({
      id: row.id,
      alias: row.name,
      email: row.email,
      orgId: row.orgId,
      teamId: row.teamId ?? "",
      blocked: row.blocked,
      logContent: row.logContent,
      budget: budgetView(row, boosts("member", row.id), now),
    })),
    users: users.map((row) => ({
      id: row.id,
      alias: row.username,
      orgId: row.orgId ?? "",
      budget: budgetView(row, boosts("user", row.id), now),
    })),
    keys: keys.map((row) => ({
      id: row.id,
      alias: row.keyAlias || row.prefix,
      prefix: row.prefix,
      userId: row.userId ?? "",
      orgId: row.orgId ?? "",
      teamId: row.teamId ?? "",
      projectId: row.projectId ?? "",
      memberId: row.memberId ?? "",
      blocked: row.blocked,
      budget: budgetView(row, boosts("key", row.id), now),
    })),
    thresholds: enterprise.budget_alert_thresholds ?? [50, 80, 100],
    companyId: company ?? "",
    canManage: hasPerm(session.permissions, PERMISSIONS.TENANCY_MANAGE),
    canBudget: hasPerm(session.permissions, PERMISSIONS.BUDGETS_MANAGE),
    canCreateKeys: hasPerm(session.permissions, PERMISSIONS.KEYS_MANAGE),
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

async function assertUniqueAlias(kind: NodeKind, alias: string, id: string | null, orgId: string | null) {
  const where = {
    ...(id ? { id: { not: id } } : {}),
  };
  const named = { equals: alias, mode: "insensitive" as const };
  const clash =
    kind === "org"
      ? await prisma.organization.findFirst({ where: { ...where, alias: named }, select: { id: true } })
      : kind === "team"
        ? await prisma.team.findFirst({ where: { ...where, alias: named, orgId }, select: { id: true } })
        : kind === "project"
          ? await prisma.project.findFirst({ where: { ...where, alias: named, orgId }, select: { id: true } })
          : null;
  if (clash) throw new Error("ALIAS_EXISTS");
}

async function companyFor(session: AuthenticatedSession, value: unknown): Promise<string> {
  const orgId = typeof value === "string" ? value.trim() : "";
  if (!orgId) throw new Error("ORG_REQUIRED");
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true } });
  if (!org || !inCompany(session, org.id)) throw new Error("ORG_NOT_FOUND");
  return org.id;
}

async function departmentFor(value: unknown, orgId: string): Promise<string | null> {
  const teamId = typeof value === "string" ? value.trim() : "";
  if (!teamId) return null;
  const team = await prisma.team.findUnique({ where: { id: teamId }, select: { id: true, orgId: true } });
  if (!team) throw new Error("TEAM_NOT_FOUND");
  if (team.orgId !== orgId) throw new Error("TEAM_NOT_IN_ORG");
  return team.id;
}

export async function loadStructureAction() {
  return runAction(async () => structurePayload(await requirePermission(PERMISSIONS.TENANCY_READ)));
}

export async function saveOrgAction(input: { id?: string; alias: string }) {
  return runAction(() =>
    mutate(PERMISSIONS.TENANCY_MANAGE, async (session) => {
      assertPlatform(session);
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
      const orgId = await companyFor(session, input.orgId);
      const existing = id ? await prisma.team.findUnique({ where: { id } }) : null;
      if (id && (!existing || !inCompany(session, existing.orgId))) throw new Error("NOT_FOUND");
      if (existing && existing.orgId !== orgId) throw new Error("ORG_LOCKED");
      await assertUniqueAlias("team", alias, id, orgId);
      const data = {
        alias,
        orgId,
        rpmLimit: cleanLimit(input.rpm, 1_000_000),
        tpmLimit: cleanLimit(input.tpm, 1_000_000_000),
      };
      const row = existing
        ? await prisma.team.update({ where: { id: existing.id }, data })
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

export async function saveProjectAction(input: ProjectInput) {
  return runAction(() =>
    mutate(PERMISSIONS.TENANCY_MANAGE, async (session) => {
      const alias = cleanAlias(input.alias);
      const id = input.id?.trim() || null;
      const orgId = await companyFor(session, input.orgId);
      const existing = id ? await prisma.project.findUnique({ where: { id } }) : null;
      if (id && (!existing || !inCompany(session, existing.orgId))) throw new Error("NOT_FOUND");
      if (existing && existing.orgId !== orgId) throw new Error("ORG_LOCKED");
      const teamId = await departmentFor(input.teamId, orgId);
      const owner = cleanText(input.owner, 200);
      await assertUniqueAlias("project", alias, id, orgId);
      const data = { alias, orgId, teamId, owner };
      const row = existing
        ? (
            await prisma.$transaction([
              prisma.project.update({ where: { id: existing.id }, data }),
              prisma.virtualKey.updateMany({ where: { projectId: existing.id }, data: { teamId, orgId } }),
            ])
          )[0]
        : await prisma.project.create({ data });
      await writeAudit({
        actor: session.user.id,
        action: existing ? "project.update" : "project.create",
        objectType: "project",
        objectId: row.id,
        before: existing
          ? { alias: existing.alias, orgId: existing.orgId, teamId: existing.teamId, owner: existing.owner }
          : undefined,
        after: data,
      });
    }),
  );
}

export async function saveMemberAction(input: MemberInput) {
  return runAction(() =>
    mutate(PERMISSIONS.TENANCY_MANAGE, async (session) => {
      const name = cleanAlias(input.alias);
      const email = cleanEmail(input.email);
      const id = input.id?.trim() || null;
      const orgId = await companyFor(session, input.orgId);
      const existing = id ? await prisma.member.findUnique({ where: { id } }) : null;
      if (id && (!existing || !inCompany(session, existing.orgId))) throw new Error("NOT_FOUND");
      if (existing && existing.orgId !== orgId) throw new Error("ORG_LOCKED");
      const teamId = await departmentFor(input.teamId, orgId);
      if (email) {
        const clash = await prisma.member.findFirst({
          where: { orgId, email, ...(id ? { id: { not: id } } : {}) },
          select: { id: true },
        });
        if (clash) throw new Error("MEMBER_EXISTS");
      }
      const data = {
        name,
        email,
        orgId,
        teamId,
        blocked: input.blocked === true,
        logContent: input.logContent !== false,
      };
      const row = existing
        ? (
            await prisma.$transaction([
              prisma.member.update({ where: { id: existing.id }, data }),
              prisma.virtualKey.updateMany({ where: { memberId: existing.id }, data: { teamId, orgId } }),
            ])
          )[0]
        : await prisma.member.create({ data });
      await writeAudit({
        actor: session.user.id,
        action: existing ? "member.update" : "member.create",
        objectType: "member",
        objectId: row.id,
        before: existing
          ? {
              name: existing.name,
              email: existing.email,
              teamId: existing.teamId,
              blocked: existing.blocked,
              logContent: existing.logContent,
            }
          : undefined,
        after: data,
      });
    }),
  );
}

async function revokeKeys(where: { projectId: string } | { memberId: string }) {
  const keys = await prisma.virtualKey.findMany({ where, select: { id: true } });
  const ids = keys.map((key) => key.id);
  return {
    count: ids.length,
    writes: [
      prisma.tempBudget.deleteMany({ where: { entityType: "key", entityId: { in: ids } } }),
      prisma.virtualKey.deleteMany({ where: { id: { in: ids } } }),
    ],
  };
}

export async function deleteNodeAction(input: { kind: NodeKind; id: string }) {
  return runAction(() =>
    mutate(PERMISSIONS.TENANCY_MANAGE, async (session) => {
      if (!isNodeKind(input.kind)) throw new Error("UNKNOWN_ENTITY_TYPE");
      const id = input.id?.trim();
      if (!id) throw new Error("MISSING_ID");
      const boosts = prisma.tempBudget.deleteMany({ where: { entityType: input.kind, entityId: id } });
      if (input.kind === "org") {
        assertPlatform(session);
        const row = await prisma.organization.findUnique({ where: { id } });
        if (!row) throw new Error("NOT_FOUND");
        const children = await Promise.all([
          prisma.team.count({ where: { orgId: id } }),
          prisma.project.count({ where: { orgId: id } }),
          prisma.member.count({ where: { orgId: id } }),
          prisma.user.count({ where: { orgId: id } }),
          prisma.virtualKey.count({ where: { orgId: id } }),
        ]);
        if (children.some(Boolean)) throw new Error("HAS_CHILDREN");
        await prisma.$transaction([prisma.organization.delete({ where: { id } }), boosts]);
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
        if (!row || !inCompany(session, row.orgId)) throw new Error("NOT_FOUND");
        await prisma.$transaction([
          prisma.project.updateMany({ where: { teamId: id }, data: { teamId: null } }),
          prisma.member.updateMany({ where: { teamId: id }, data: { teamId: null } }),
          prisma.virtualKey.updateMany({ where: { teamId: id }, data: { teamId: null } }),
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
      if (input.kind === "project") {
        const row = await prisma.project.findUnique({ where: { id } });
        if (!row || !inCompany(session, row.orgId)) throw new Error("NOT_FOUND");
        const revoked = await revokeKeys({ projectId: id });
        await prisma.$transaction([...revoked.writes, prisma.project.delete({ where: { id } }), boosts]);
        await writeAudit({
          actor: session.user.id,
          action: "project.delete",
          objectType: "project",
          objectId: id,
          before: { alias: row.alias, orgId: row.orgId, teamId: row.teamId, owner: row.owner },
          after: { revokedKeys: revoked.count },
        });
        return;
      }
      const row = await prisma.member.findUnique({ where: { id } });
      if (!row) throw new Error("NOT_FOUND");
      assertInCompany(session, row.orgId);
      const revoked = await revokeKeys({ memberId: id });
      await prisma.$transaction([...revoked.writes, prisma.member.delete({ where: { id } }), boosts]);
      await writeAudit({
        actor: session.user.id,
        action: "member.delete",
        objectType: "member",
        objectId: id,
        before: { name: row.name, email: row.email, orgId: row.orgId, teamId: row.teamId },
        after: { revokedKeys: revoked.count },
      });
    }),
  );
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

export async function setBudgetAction(input: BudgetInput) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.BUDGETS_MANAGE);
    if (!isBudgetKind(input.kind)) return actionFail("UNKNOWN_ENTITY_TYPE");
    assertBudgetScope(session, input.kind);
    const id = input.id?.trim();
    if (!id) return actionFail("MISSING_ID");
    const maxBudget = budgetAmount(input.maxBudget);
    const budgetDuration = budgetPeriod(String(input.budgetDuration ?? ""));
    if (maxBudget == null || budgetDuration == null) return actionFail("VALIDATION");
    const now = new Date();
    const record = await holderRecord(session, input.kind, id);
    if (!record) return actionFail("NOT_FOUND");
    if (capConflict(maxBudget, await ancestorsOf(session, record, now))) {
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
    assertBudgetScope(session, input.kind);
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
    assertBudgetScope(session, boost.entityType);
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
  });
}
