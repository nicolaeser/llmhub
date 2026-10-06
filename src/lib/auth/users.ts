import "server-only";
import prisma from "@/lib/db/prisma";
import { SESSION_IDLE_TTL_MS } from "@/lib/auth/cookie";
import { AuthError, isPrismaCode, parseAuthInput } from "@/lib/auth/errors";
import { assertCanGrant, assertCanManage, canManage, grantActor } from "@/lib/auth/grants";
import {
  effectivePermissions,
  hasPerm,
  isRoleTemplateKey,
  permissionList,
  PERMISSIONS,
} from "@/lib/auth/permissions";
import { assertPasswordPolicy, hashPassword } from "@/lib/auth/password";
import { roleOptions } from "@/lib/auth/roles";
import { requestMeta } from "@/lib/auth/session";
import { requireStepUp } from "@/lib/auth/second-factor";
import { securityEvent, userActor } from "@/lib/auth/security-events";
import { clearSecondFactorFailures } from "@/lib/auth/throttle";
import { writeAudit } from "@/lib/gateway/audit";
import {
  idSchema,
  userCreateSchema,
  userPasswordSchema,
  userRoleSchema,
  userSecurityResetSchema,
} from "@/schemas/auth";
import type { AuthenticatedSession, GrantActor, TargetRow } from "@/types/auth";
import type { ConsoleUser, UsersConsolePayload } from "@/types/users";

function targetPermissions(target: TargetRow) {
  return effectivePermissions({
    isOwner: target.isOwner,
    rolePermissions: target.role?.permissions ?? [],
  });
}

async function loadTarget(userId: unknown) {
  const id = parseAuthInput(idSchema, userId);
  const target = await prisma.user.findUnique({
    where: { id },
    include: { role: { select: { permissions: true } } },
  });
  if (!target) throw new AuthError("USER_NOT_FOUND");
  return target;
}

function assertManageable(
  session: AuthenticatedSession,
  target: TargetRow,
  options: { allowSelf?: boolean } = {},
) {
  if (!options.allowSelf && target.id === session.user.id) throw new AuthError("CANNOT_SELF");
  if (target.isOwner) throw new AuthError("OWNER_PROTECTED");
  assertCanManage(grantActor(session), targetPermissions(target), "USER_PROTECTED");
}

async function resolveTenancy(orgId?: string, teamId?: string) {
  const nextOrgId = orgId?.trim() || null;
  const nextTeamId = teamId?.trim() || null;
  const team = nextTeamId
    ? await prisma.team.findUnique({ where: { id: nextTeamId }, select: { id: true, orgId: true } })
    : null;
  if (nextTeamId && !team) throw new AuthError("VALIDATION");
  if (team?.orgId && nextOrgId && team.orgId !== nextOrgId) throw new AuthError("VALIDATION");
  const resolvedOrgId = team?.orgId ?? nextOrgId;
  if (
    resolvedOrgId &&
    !(await prisma.organization.findUnique({ where: { id: resolvedOrgId }, select: { id: true } }))
  ) {
    throw new AuthError("VALIDATION");
  }
  return { orgId: resolvedOrgId, teamId: team?.id ?? null };
}

async function assignableRole(actor: GrantActor, roleId: string) {
  const role = await prisma.role.findUnique({ where: { id: roleId } });
  if (!role) throw new AuthError("ROLE_NOT_FOUND");
  assertCanGrant(actor, permissionList(role.permissions));
  return role;
}

export async function usersConsole(session: AuthenticatedSession): Promise<UsersConsolePayload> {
  const actor = grantActor(session);
  const now = new Date();
  const [users, roles, orgs, teams] = await Promise.all([
    prisma.user.findMany({
      orderBy: { email: "asc" },
      include: {
        role: { select: { id: true, name: true, templateKey: true, permissions: true } },
        org: { select: { alias: true } },
        team: { select: { alias: true } },
        totp: { select: { enabledAt: true } },
        _count: { select: { passkeys: true } },
        sessions: {
          where: {
            expiresAt: { gt: now },
            lastActive: { gt: new Date(now.getTime() - SESSION_IDLE_TTL_MS) },
          },
          select: { lastActive: true },
          orderBy: { lastActive: "desc" },
        },
      },
    }),
    roleOptions(actor),
    prisma.organization.findMany({ orderBy: { alias: "asc" }, select: { id: true, alias: true } }),
    prisma.team.findMany({
      orderBy: { alias: "asc" },
      select: { id: true, alias: true, orgId: true },
    }),
  ]);
  return {
    users: users.map(
      (user): ConsoleUser => ({
        id: user.id,
        username: user.username,
        email: user.email,
        roleId: user.roleId,
        roleName: user.role?.name ?? null,
        roleTemplateKey: isRoleTemplateKey(user.role?.templateKey) ? user.role.templateKey : null,
        isOwner: user.isOwner,
        blocked: user.blocked,
        orgId: user.orgId,
        teamId: user.teamId,
        orgAlias: user.org?.alias ?? "",
        teamAlias: user.team?.alias ?? "",
        twoFactorEnabled: Boolean(user.totp?.enabledAt),
        passkeys: user._count.passkeys,
        activeSessions: user.sessions.length,
        lastActive: user.sessions[0]?.lastActive.toISOString() ?? null,
        mustChangePassword: user.mustChangePassword,
        logContent: user.logContent,
        revision: user.revision,
        manageable:
          user.id !== session.user.id &&
          !user.isOwner &&
          canManage(actor, targetPermissions(user)),
      }),
    ),
    roles,
    orgs,
    teams,
    selfId: session.user.id,
    canManage: hasPerm(session.permissions, PERMISSIONS.USERS_MANAGE),
    canSecure: hasPerm(session.permissions, PERMISSIONS.USERS_SECURITY),
  };
}

export async function createUser(session: AuthenticatedSession, raw: unknown) {
  const input = parseAuthInput(userCreateSchema, raw);
  const role = await assignableRole(grantActor(session), input.roleId);
  const tenancy = await resolveTenancy(input.orgId, input.teamId);
  const exists = await prisma.user.findFirst({
    where: { OR: [{ email: input.email }, { username: input.username }] },
    select: { id: true },
  });
  if (exists) throw new AuthError("USER_EXISTS");
  try {
    const user = await prisma.user.create({
      data: {
        username: input.username,
        email: input.email,
        password: await hashPassword(input.password),
        mustChangePassword: true,
        roleId: role.id,
        orgId: tenancy.orgId,
        teamId: tenancy.teamId,
      },
      select: { id: true },
    });
    await writeAudit({
      actor: session.user.id,
      action: "user.create",
      objectType: "user",
      objectId: user.id,
      after: { username: input.username, email: input.email, roleId: role.id, ...tenancy },
    });
    return user;
  } catch (error) {
    if (isPrismaCode(error, "P2002")) throw new AuthError("USER_EXISTS");
    throw error;
  }
}

export async function setUserBlocked(
  session: AuthenticatedSession,
  userId: unknown,
  blocked: boolean,
) {
  const target = await loadTarget(userId);
  assertManageable(session, target);
  const meta = await requestMeta();
  await prisma.user.update({
    where: { id: target.id },
    data: {
      blocked,
      revision: { increment: 1 },
      ...(blocked ? { sessions: { deleteMany: {} }, loginChallenges: { deleteMany: {} } } : {}),
      securityEvents: {
        create: securityEvent(
          userActor(session.user.id),
          blocked ? "account.blocked" : "account.unblocked",
          meta.ipAddress,
        ),
      },
    },
    select: { id: true },
  });
  await writeAudit({
    actor: session.user.id,
    action: "user.block",
    objectType: "user",
    objectId: target.id,
    after: { blocked },
  });
}

export async function setUserContentLogging(
  session: AuthenticatedSession,
  userId: unknown,
  enabled: boolean,
) {
  const target = await loadTarget(userId);
  assertManageable(session, target);
  await prisma.user.update({
    where: { id: target.id },
    data: { logContent: enabled, revision: { increment: 1 } },
    select: { id: true },
  });
  await writeAudit({
    actor: session.user.id,
    action: "user.content_logging",
    objectType: "user",
    objectId: target.id,
    after: { logContent: enabled },
  });
}

export async function deleteUser(session: AuthenticatedSession, userId: unknown) {
  const target = await loadTarget(userId);
  assertManageable(session, target);
  await prisma.user.delete({ where: { id: target.id } });
  await writeAudit({
    actor: session.user.id,
    action: "user.delete",
    objectType: "user",
    objectId: target.id,
    before: {
      username: target.username,
      email: target.email,
      roleId: target.roleId,
      blocked: target.blocked,
      orgId: target.orgId,
      teamId: target.teamId,
    },
  });
}

export async function setUserPassword(session: AuthenticatedSession, raw: unknown) {
  const input = parseAuthInput(userPasswordSchema, raw);
  const target = await loadTarget(input.userId);
  assertManageable(session, target);
  assertPasswordPolicy(input.password, [target.email, target.username]);
  await requireStepUp(session.user.id, input.code);
  const meta = await requestMeta();
  await prisma.user.update({
    where: { id: target.id },
    data: {
      password: await hashPassword(input.password),
      mustChangePassword: input.requireChange,
      passwordChangedAt: new Date(),
      revision: { increment: 1 },
      sessions: { deleteMany: {} },
      loginChallenges: { deleteMany: {} },
      securityEvents: {
        create: securityEvent(userActor(session.user.id), "password.reset", meta.ipAddress),
      },
    },
    select: { id: true },
  });
  await writeAudit({
    actor: session.user.id,
    action: "user.password",
    objectType: "user",
    objectId: target.id,
    after: { passwordChanged: true, mustChangePassword: input.requireChange },
  });
}

export async function assignUserRole(session: AuthenticatedSession, raw: unknown) {
  const input = parseAuthInput(userRoleSchema, raw);
  const target = await loadTarget(input.userId);
  assertManageable(session, target);
  const role = await assignableRole(grantActor(session), input.roleId);
  const meta = await requestMeta();
  const { count } = await prisma.user.updateMany({
    where: { id: target.id, revision: input.revision },
    data: { roleId: role.id, revision: { increment: 1 } },
  });
  if (!count) throw new AuthError("USER_CHANGED");
  await prisma.userSecurityEvent.create({
    data: {
      userId: target.id,
      ...securityEvent(userActor(session.user.id), "role.changed", meta.ipAddress),
    },
  });
  await writeAudit({
    actor: session.user.id,
    action: "role.assign",
    objectType: "user",
    objectId: target.id,
    before: { roleId: target.roleId },
    after: { roleId: role.id },
  });
}

export async function resetUserTwoFactor(session: AuthenticatedSession, raw: unknown) {
  const input = parseAuthInput(userSecurityResetSchema, raw);
  const target = await loadTarget(input.userId);
  assertManageable(session, target);
  await requireStepUp(session.user.id, input.code);
  const meta = await requestMeta();
  await prisma.$transaction([
    prisma.userTotp.deleteMany({ where: { userId: target.id } }),
    prisma.user.update({
      where: { id: target.id },
      data: {
        revision: { increment: 1 },
        passkeys: { deleteMany: {} },
        sessions: { deleteMany: {} },
        loginChallenges: { deleteMany: {} },
        securityEvents: {
          create: securityEvent(userActor(session.user.id), "2fa.reset", meta.ipAddress),
        },
      },
      select: { id: true },
    }),
  ]);
  await clearSecondFactorFailures(target.id);
  await writeAudit({
    actor: session.user.id,
    action: "user.2fa_reset",
    objectType: "user",
    objectId: target.id,
  });
}

export async function revokeUserSessions(session: AuthenticatedSession, userId: unknown) {
  const target = await loadTarget(userId);
  assertManageable(session, target);
  const meta = await requestMeta();
  const { count } = await prisma.session.deleteMany({ where: { userId: target.id } });
  if (count) {
    await prisma.userSecurityEvent.create({
      data: {
        userId: target.id,
        ...securityEvent(userActor(session.user.id), "sessions.revoked", meta.ipAddress),
      },
    });
  }
  await writeAudit({
    actor: session.user.id,
    action: "user.sessions_revoked",
    objectType: "user",
    objectId: target.id,
    after: { revoked: count },
  });
  return { revoked: count };
}
