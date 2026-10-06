import "server-only";
import prisma from "@/lib/db/prisma";
import { AuthError } from "@/lib/auth/errors";
import { matchTotp, openTotpSecret } from "@/lib/auth/totp";
import {
  normalizeRecoveryCode,
  recoveryCodeHash,
} from "@/lib/auth/recovery-codes";
import {
  clearSecondFactorFailures,
  releaseAttempts,
  reserveSecondFactorAttempt,
  secondFactorLockReached,
} from "@/lib/auth/throttle";
import { SYSTEM_ACTOR, recordSecurityEvent, securityEvent, userActor } from "@/lib/auth/security-events";
import type { SecondFactorProof } from "@/types/security";

const invalidSecondFactor = () => new AuthError("INVALID_SECOND_FACTOR");

async function lockOut(userId: string): Promise<never> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      loginChallenges: { deleteMany: {} },
      securityEvents: { create: securityEvent(SYSTEM_ACTOR, "2fa.locked") },
    },
    select: { id: true },
  });
  throw new AuthError("SECOND_FACTOR_LOCKED");
}

export async function guardSecondFactor<T>(
  userId: string,
  verify: () => Promise<T | null>,
  failure: () => AuthError = invalidSecondFactor,
): Promise<T> {
  const reservation = await reserveSecondFactorAttempt(userId);
  let result: T | null;
  try {
    result = await verify();
  } catch (error) {
    await releaseAttempts(reservation);
    throw error;
  }
  if (result === null) {
    if (await secondFactorLockReached(userId)) return lockOut(userId);
    throw failure();
  }
  await clearSecondFactorFailures(userId);
  return result;
}

async function consumeTotp(
  userId: string,
  row: { secret: string; lastTimeStep: number | null },
  code: string,
): Promise<boolean> {
  const step = await matchTotp(openTotpSecret(userId, row.secret), code.trim(), row.lastTimeStep);
  if (step === null) return false;
  const { count } = await prisma.userTotp.updateMany({
    where: {
      userId,
      secret: row.secret,
      OR: [{ lastTimeStep: null }, { lastTimeStep: { lt: step } }],
    },
    data: { lastTimeStep: step },
  });
  return count === 1;
}

async function consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
  const normalized = normalizeRecoveryCode(code);
  if (!normalized) return false;
  const { count } = await prisma.recoveryCode.updateMany({
    where: {
      userId,
      codeHash: recoveryCodeHash(normalized),
      usedAt: null,
    },
    data: { usedAt: new Date() },
  });
  if (count !== 1) return false;
  await recordSecurityEvent(userId, userActor(userId), "2fa.recovery_used");
  return true;
}

export async function verifySecondFactor(
  userId: string,
  proof: SecondFactorProof,
): Promise<"TOTP" | "RECOVERY"> {
  const row = await prisma.userTotp.findUnique({
    where: { userId },
    select: { secret: true, enabledAt: true, lastTimeStep: true },
  });
  if (!row?.enabledAt || !row.secret) throw new AuthError("TWO_FACTOR_ENROLLMENT_REQUIRED");
  const totp = { secret: row.secret, lastTimeStep: row.lastTimeStep };
  return guardSecondFactor(userId, async () => {
    if (proof.method === "totp") {
      return (await consumeTotp(userId, totp, proof.code)) ? ("TOTP" as const) : null;
    }
    return (await consumeRecoveryCode(userId, proof.code)) ? ("RECOVERY" as const) : null;
  });
}

export async function requireStepUp(userId: string, rawCode: unknown) {
  const code = typeof rawCode === "string" ? rawCode.trim().slice(0, 64) : "";
  if (!code) return guardSecondFactor(userId, async () => null);
  return verifySecondFactor(userId, {
    method: /^\d{6}$/.test(code) ? "totp" : "recovery",
    code,
  });
}

export async function remainingRecoveryCodes(userId: string) {
  return prisma.recoveryCode.count({ where: { userId, usedAt: null } });
}
