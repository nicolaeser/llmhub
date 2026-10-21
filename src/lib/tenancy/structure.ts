import "server-only";

import prisma from "@/lib/db/prisma";
import { requirePermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { assertPlatform, companyOf, inCompany, keyScope } from "@/lib/auth/scope";
import { writeAudit } from "@/lib/audit";
import { getEnterprise } from "@/lib/settings/enterprise";
import { mailEnabled } from "@/lib/mail/send";
import { money } from "@/lib/utils/money";
import type { AuthenticatedSession, Permission } from "@/types/auth";
import type {
  BudgetKind,
  MemberInput,
  ProjectInput,
  StructurePayload,
  TenancyKind,
} from "@/types/structure";
import {
  assertInCompany,
  cleanAlias,
  cleanEmail,
  cleanLimit,
  cleanText,
  companyFor,
  departmentFor,
} from "@/lib/tenancy/guards";
import { HOLDER, budgetView } from "@/lib/tenancy/budgets";
import { canReport, reportViews } from "@/lib/reports/manage";
import { managesMcpRules, seesMcp } from "@/lib/mcp/scope";

const NODE_KINDS: readonly string[] = ["org", "team", "project", "member"];

function isNodeKind(value: unknown): value is TenancyKind {
  return typeof value === "string" && NODE_KINDS.includes(value);
}

async function structurePayload(session: AuthenticatedSession): Promise<StructurePayload> {
  const now = new Date();
  const company = companyOf(session);
  const inScope = company ? { orgId: company } : {};
  const seesKeys = hasPerm(session.permissions, PERMISSIONS.KEYS_READ);
  const managesKeys = hasPerm(session.permissions, PERMISSIONS.KEYS_MANAGE);
  const seesReports = hasPerm(session.permissions, PERMISSIONS.SPEND_READ_ALL);
  const [orgs, teams, projects, members, users, keys, temps, enterprise, reports] = await Promise.all([
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
    seesReports ? reportViews(session, now) : Promise.resolve([]),
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
    canSeeKeys: seesKeys,
    canManageKeys: seesKeys && managesKeys,
    canCreateKeys: seesKeys && managesKeys && hasPerm(session.permissions, PERMISSIONS.TENANCY_MANAGE),
    canMcp: seesKeys && managesMcpRules(session, company),
    canSeeMcp: seesMcp(session),
    reports,
    canSeeReports: seesReports,
    canReport: canReport(session),
    canSeeSettings: !company && hasPerm(session.permissions, PERMISSIONS.SETTINGS_READ),
    mailEnabled: mailEnabled(),
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

async function assertUniqueAlias(kind: TenancyKind, alias: string, id: string | null, orgId: string | null) {
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

export async function loadStructure() {
  return structurePayload(await requirePermission(PERMISSIONS.TENANCY_READ));
}

export async function saveOrg(input: { id?: string; alias: string }) {
  return mutate(PERMISSIONS.TENANCY_MANAGE, async (session) => {
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
    });
}

export async function saveTeam(input: {
  id?: string;
  alias: string;
  orgId: string;
  rpm: number;
  tpm: number;
}) {
  return mutate(PERMISSIONS.TENANCY_MANAGE, async (session) => {
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
    });
}

export async function saveProject(input: ProjectInput) {
  return mutate(PERMISSIONS.TENANCY_MANAGE, async (session) => {
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
    });
}

export async function saveMember(input: MemberInput) {
  return mutate(PERMISSIONS.TENANCY_MANAGE, async (session) => {
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
    });
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

export async function deleteNode(input: { kind: TenancyKind; id: string }) {
  return mutate(PERMISSIONS.TENANCY_MANAGE, async (session) => {
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
    });
}
