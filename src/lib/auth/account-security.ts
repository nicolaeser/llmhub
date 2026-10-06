import "server-only";
import prisma from "@/lib/db/prisma";
import { AuthError, isPrismaCode, parseAuthInput } from "@/lib/auth/errors";
import { assertPasswordPolicy, hashPassword, verifyPassword } from "@/lib/auth/password";
import { SESSION_IDLE_TTL_MS } from "@/lib/auth/cookie";
import { SESSION_FACTORS, requestMeta } from "@/lib/auth/session";
import {
  passkeyRegistrationOptions,
  passkeysAvailable,
  registerPasskey,
} from "@/lib/auth/passkeys";
import { RECOVERY_CODE_COUNT, newRecoveryCodes } from "@/lib/auth/recovery-codes";
import {
  guardSecondFactor,
  remainingRecoveryCodes,
  requireStepUp,
} from "@/lib/auth/second-factor";
import {
  LOGIN_ATTEMPT_WINDOW_MS,
  clearFailedAttempts,
  releaseAttempts,
  reserveAttempts,
} from "@/lib/auth/throttle";
import {
  matchTotp,
  newTotpSecret,
  openTotpSecret,
  sealTotpSecret,
  totpEnrollment,
} from "@/lib/auth/totp";
import {
  recordSecurityEvent,
  securityEvent,
  securityEventViews,
  userActor,
} from "@/lib/auth/security-events";
import {
  changePasswordSchema,
  passkeyFinishSchema,
  passkeyRemoveSchema,
  passkeyRenameSchema,
  sessionRevokeSchema,
  stepUpSchema,
  totpCodeSchema,
} from "@/schemas/auth";
import type { AuthenticatedSession } from "@/types/auth";
import type { PasskeyView, SecurityOverview, SessionView, TotpEnrollment } from "@/types/security";

const REPLACEMENT_WINDOW_MS = 15 * 60 * 1000;
const PASSWORD_CHANGE_FAILURES = 5;

async function passkeyViews(userId: string): Promise<PasskeyView[]> {
  const rows = await prisma.userPasskey.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      backedUp: true,
      createdAt: true,
      lastUsedAt: true,
    },
  });
  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  }));
}

async function sessionViews(userId: string, currentId: string): Promise<SessionView[]> {
  const rows = await prisma.session.findMany({
    where: {
      userId,
      expiresAt: { gt: new Date() },
      lastActive: { gt: new Date(Date.now() - SESSION_IDLE_TTL_MS) },
    },
    orderBy: { lastActive: "desc" },
    take: 20,
    select: {
      id: true,
      secondFactor: true,
      ipAddress: true,
      userAgent: true,
      createdAt: true,
      lastActive: true,
      expiresAt: true,
    },
  });
  return rows.map((row) => ({
    id: row.id,
    current: row.id === currentId,
    secondFactor: SESSION_FACTORS.find((factor) => factor === row.secondFactor) ?? null,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    createdAt: row.createdAt.toISOString(),
    lastActive: row.lastActive.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  }));
}

export async function securityOverview(session: AuthenticatedSession): Promise<SecurityOverview> {
  const userId = session.user.id;
  const [totp, recoveryCodesRemaining, passkeys, sessions, events] = await Promise.all([
    prisma.userTotp.findUnique({ where: { userId }, select: { enabledAt: true } }),
    remainingRecoveryCodes(userId),
    passkeyViews(userId),
    sessionViews(userId, session.sessionId),
    securityEventViews(userId, 15),
  ]);
  return {
    user: {
      username: session.user.username,
      email: session.user.email,
      isOwner: session.isOwner,
      roleName: session.role?.name ?? null,
      roleTemplateKey: session.role?.templateKey ?? null,
    },
    password: { changedAt: session.user.passwordChangedAt?.toISOString() ?? null },
    twoFactor: {
      enabledAt: totp?.enabledAt?.toISOString() ?? null,
      recoveryCodesRemaining,
      recoveryCodesTotal: RECOVERY_CODE_COUNT,
    },
    passkeys,
    passkeysAvailable: passkeysAvailable(),
    sessions,
    events,
  };
}

export async function changeOwnPassword(session: AuthenticatedSession, raw: unknown) {
  const input = parseAuthInput(changePasswordSchema, raw);
  const userId = session.user.id;
  assertPasswordPolicy(input.newPassword, [session.user.email, session.user.username]);
  const throttleKey = `password-change:${userId}`;
  const reservation = await reserveAttempts([
    { key: throttleKey, limit: PASSWORD_CHANGE_FAILURES, windowMs: LOGIN_ATTEMPT_WINDOW_MS },
  ]);
  const current = session.user.password;
  const matches = await verifyPassword(current, input.currentPassword);
  if (!matches) throw new AuthError("PASSWORD_INCORRECT");
  await releaseAttempts(reservation);
  if (await verifyPassword(current, input.newPassword)) throw new AuthError("PASSWORD_REUSED");
  const meta = await requestMeta();
  try {
    await prisma.user.update({
      where: { id: userId, password: current },
      data: {
        password: await hashPassword(input.newPassword),
        passwordChangedAt: new Date(),
        mustChangePassword: false,
        revision: { increment: 1 },
        sessions: { deleteMany: { id: { not: session.sessionId } } },
        securityEvents: {
          create: securityEvent(userActor(userId), "password.changed", meta.ipAddress),
        },
      },
      select: { id: true },
    });
  } catch (error) {
    if (isPrismaCode(error, "P2025")) throw new AuthError("PASSWORD_CHANGED");
    throw error;
  }
  await clearFailedAttempts(throttleKey);
  return { changed: true as const };
}

export async function startTotpReplacement(
  session: AuthenticatedSession,
  raw: unknown,
): Promise<TotpEnrollment> {
  const { code } = parseAuthInput(stepUpSchema, raw);
  const userId = session.user.id;
  await requireStepUp(userId, code);
  const secret = newTotpSecret();
  const pendingAt = new Date();
  const { count } = await prisma.userTotp.updateMany({
    where: { userId, enabledAt: { not: null } },
    data: { pendingSecret: sealTotpSecret(userId, secret), pendingAt },
  });
  if (count !== 1) throw new AuthError("TWO_FACTOR_CHANGED");
  return {
    ...(await totpEnrollment(session.user.email, secret)),
    expiresAt: new Date(pendingAt.getTime() + REPLACEMENT_WINDOW_MS).toISOString(),
  };
}

export async function confirmTotpReplacement(session: AuthenticatedSession, raw: unknown) {
  const { code } = parseAuthInput(totpCodeSchema, raw);
  const userId = session.user.id;
  const row = await prisma.userTotp.findUnique({
    where: { userId },
    select: { pendingSecret: true, pendingAt: true, enabledAt: true },
  });
  if (
    !row?.enabledAt ||
    !row.pendingSecret ||
    !row.pendingAt ||
    Date.now() - row.pendingAt.getTime() > REPLACEMENT_WINDOW_MS
  ) {
    throw new AuthError("TWO_FACTOR_CHANGED");
  }
  const pendingSecret = row.pendingSecret;
  const step = await guardSecondFactor(userId, () =>
    matchTotp(openTotpSecret(userId, pendingSecret), code, null),
  );
  const meta = await requestMeta();
  try {
    await prisma.userTotp.update({
      where: { userId, pendingSecret: row.pendingSecret },
      data: {
        secret: row.pendingSecret,
        enabledAt: new Date(),
        lastTimeStep: step,
        pendingSecret: null,
        pendingAt: null,
        user: {
          update: {
            sessions: { deleteMany: { id: { not: session.sessionId } } },
            securityEvents: {
              create: securityEvent(userActor(userId), "2fa.replaced", meta.ipAddress),
            },
          },
        },
      },
      select: { userId: true },
    });
  } catch (error) {
    if (isPrismaCode(error, "P2025")) throw new AuthError("TWO_FACTOR_CHANGED");
    throw error;
  }
  return { replaced: true as const };
}

export async function cancelTotpReplacement(session: AuthenticatedSession) {
  await prisma.userTotp.updateMany({
    where: { userId: session.user.id, enabledAt: { not: null } },
    data: { pendingSecret: null, pendingAt: null },
  });
  return { cancelled: true as const };
}

export async function regenerateRecoveryCodes(session: AuthenticatedSession, raw: unknown) {
  const { code } = parseAuthInput(stepUpSchema, raw);
  const userId = session.user.id;
  await requireStepUp(userId, code);
  const { codes, hashes } = newRecoveryCodes();
  const meta = await requestMeta();
  try {
    await prisma.userTotp.update({
      where: { userId, enabledAt: { not: null } },
      data: {
        recoveryCodes: {
          deleteMany: {},
          createMany: { data: hashes.map((codeHash) => ({ codeHash })) },
        },
        user: {
          update: {
            securityEvents: {
              create: securityEvent(userActor(userId), "2fa.recovery_regenerated", meta.ipAddress),
            },
          },
        },
      },
      select: { userId: true },
    });
  } catch (error) {
    if (isPrismaCode(error, "P2025")) throw new AuthError("TWO_FACTOR_CHANGED");
    throw error;
  }
  return { recoveryCodes: codes };
}

export async function revokeOwnSession(session: AuthenticatedSession, raw: unknown) {
  const { id } = parseAuthInput(sessionRevokeSchema, raw);
  if (id === session.sessionId) throw new AuthError("CURRENT_SESSION");
  const userId = session.user.id;
  const { count } = await prisma.session.deleteMany({ where: { id, userId } });
  if (count) {
    await recordSecurityEvent(userId, userActor(userId), "sessions.revoked", (await requestMeta()).ipAddress);
  }
  return { revoked: count };
}

export async function revokeOtherSessions(session: AuthenticatedSession) {
  const userId = session.user.id;
  const { count } = await prisma.session.deleteMany({
    where: { userId, id: { not: session.sessionId } },
  });
  if (count) {
    await recordSecurityEvent(userId, userActor(userId), "sessions.revoked", (await requestMeta()).ipAddress);
  }
  return { revoked: count };
}

export async function startPasskeyRegistration(session: AuthenticatedSession, raw: unknown) {
  const { code } = parseAuthInput(stepUpSchema, raw);
  await requireStepUp(session.user.id, code);
  return passkeyRegistrationOptions(session.user);
}

export async function finishPasskeyRegistration(session: AuthenticatedSession, raw: unknown) {
  const input = parseAuthInput(passkeyFinishSchema, raw);
  return registerPasskey(
    session.user.id,
    input.name,
    input.response,
    (await requestMeta()).ipAddress,
  );
}

export async function renameOwnPasskey(session: AuthenticatedSession, raw: unknown) {
  const input = parseAuthInput(passkeyRenameSchema, raw);
  const { count } = await prisma.userPasskey.updateMany({
    where: { id: input.id, userId: session.user.id },
    data: { name: input.name },
  });
  if (!count) throw new AuthError("PASSKEY_NOT_FOUND");
  return { renamed: true as const };
}

export async function removeOwnPasskey(session: AuthenticatedSession, raw: unknown) {
  const input = parseAuthInput(passkeyRemoveSchema, raw);
  const userId = session.user.id;
  await requireStepUp(userId, input.code);
  const { count } = await prisma.userPasskey.deleteMany({ where: { id: input.id, userId } });
  if (!count) throw new AuthError("PASSKEY_NOT_FOUND");
  await recordSecurityEvent(userId, userActor(userId), "passkey.removed", (await requestMeta()).ipAddress);
  return { removed: true as const };
}
