import prisma from "@/lib/db/prisma";
import { digest } from "@/lib/crypto";
import { effectivePermissions } from "@/lib/auth/permissions";
import type { User } from "@/generated/prisma/client";
import type { AuthenticatedSession, Permission } from "@/types/auth";
import { createUser, uniqueName } from "./database";

export function sessionOf(
  user: User,
  options: { owner?: boolean; permissions?: readonly Permission[]; sessionId?: string } = {},
): AuthenticatedSession {
  const isOwner = options.owner ?? user.isOwner;
  return {
    error: false,
    sessionId: options.sessionId ?? uniqueName("session"),
    user,
    isOwner,
    role: null,
    permissions: effectivePermissions({ isOwner, rolePermissions: options.permissions ?? [], orgId: user.orgId }),
    secondFactor: "TOTP",
    ipAddress: null,
    userAgent: null,
  };
}

type KeyInput = {
  userId?: string | null;
  orgId?: string | null;
  teamId?: string | null;
  projectId?: string | null;
  memberId?: string | null;
};

export class TestData {
  private readonly orgIds: string[] = [];
  private readonly userIds: string[] = [];
  private readonly attemptKeys: string[] = [];
  private readonly signInEmails: string[] = [];

  async org(data: { maxBudget?: number } = {}) {
    const org = await prisma.organization.create({ data: { alias: uniqueName("org"), ...data } });
    this.orgIds.push(org.id);
    return org;
  }

  team(orgId: string, data: { maxBudget?: number } = {}) {
    return prisma.team.create({ data: { alias: uniqueName("team"), orgId, ...data } });
  }

  project(orgId: string, teamId: string | null = null, data: { maxBudget?: number } = {}) {
    return prisma.project.create({ data: { alias: uniqueName("project"), orgId, teamId, ...data } });
  }

  member(orgId: string, teamId: string | null = null, data: { maxBudget?: number; blocked?: boolean } = {}) {
    return prisma.member.create({ data: { name: uniqueName("member"), orgId, teamId, ...data } });
  }

  async user(input: { orgId?: string; isOwner?: boolean } = {}) {
    const user = await createUser(input);
    this.userIds.push(user.id);
    return user;
  }

  async key(input: KeyInput & { maxBudget?: number } = {}) {
    const hash = uniqueName("hash");
    const key = await prisma.virtualKey.create({
      data: { ...input, hash, prefix: hash.slice(-8), keyAlias: uniqueName("key") },
    });
    return key;
  }

  ownUser(id: string) {
    this.userIds.push(id);
  }

  ownAttempts(...keys: string[]) {
    this.attemptKeys.push(...keys);
  }

  ownSignInAttempts(...emails: string[]) {
    this.signInEmails.push(...emails);
  }

  async cleanup() {
    const orgIds = this.orgIds;
    const userIds = this.userIds;
    const inOrg = { orgId: { in: orgIds } };
    const [teams, projects, members] = await Promise.all([
      prisma.team.findMany({ where: inOrg, select: { id: true } }),
      prisma.project.findMany({ where: inOrg, select: { id: true } }),
      prisma.member.findMany({ where: inOrg, select: { id: true } }),
    ]);
    const projectIds = projects.map((row) => row.id);
    const memberIds = members.map((row) => row.id);
    const keys = await prisma.virtualKey.findMany({
      where: {
        OR: [
          inOrg,
          { userId: { in: userIds } },
          { projectId: { in: projectIds } },
          { memberId: { in: memberIds } },
        ],
      },
      select: { id: true },
    });
    const keyIds = keys.map((row) => row.id);
    const users = await prisma.user.findMany({
      where: { OR: [{ id: { in: userIds } }, inOrg] },
      select: { id: true, email: true },
    });
    const accountKeys = [...this.signInEmails, ...users.map((row) => row.email)].map(
      (email) => `login:${digest(email)}`,
    );
    const entityIds = [...orgIds, ...userIds, ...teams.map((row) => row.id), ...projectIds, ...memberIds, ...keyIds];
    await prisma.tempBudget.deleteMany({ where: { entityId: { in: entityIds } } });
    await prisma.usageReport.deleteMany({ where: inOrg });
    await prisma.virtualKey.deleteMany({ where: { id: { in: keyIds } } });
    await prisma.gatewayAuditLog.deleteMany({
      where: { OR: [{ actor: { in: userIds } }, { objectId: { in: entityIds } }] },
    });
    await prisma.loginAttempt.deleteMany({
      where: {
        OR: [
          { key: { in: this.attemptKeys } },
          ...users.map((row) => ({ key: { contains: row.id } })),
          ...accountKeys.map((key) => ({ key: { startsWith: key } })),
        ],
      },
    });
    await prisma.member.deleteMany({ where: inOrg });
    await prisma.project.deleteMany({ where: inOrg });
    await prisma.team.deleteMany({ where: inOrg });
    await prisma.user.deleteMany({ where: { OR: [{ id: { in: userIds } }, inOrg] } });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  }
}

export async function preserveSetting(key: string): Promise<() => Promise<void>> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return async () => {
    if (row) {
      await prisma.setting.upsert({ where: { key }, update: { value: row.value }, create: { key, value: row.value } });
    } else {
      await prisma.setting.deleteMany({ where: { key } });
    }
  };
}
