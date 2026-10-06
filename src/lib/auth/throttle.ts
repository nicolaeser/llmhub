import "server-only";
import prisma from "@/lib/db/prisma";
import { AuthError } from "@/lib/auth/errors";
import { allowRequest } from "@/lib/rate-limit/window";
import type { AttemptLimit } from "@/types/security";

export const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
export const ATTEMPT_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_FAILURES = 10;

const SECOND_FACTOR_WINDOWS = [
  { limit: 10, ms: 15 * 60 * 1000 },
  { limit: 30, ms: 24 * 60 * 60 * 1000 },
] as const;

const secondFactorKey = (userId: string) => `2fa:${userId}`;

async function attemptsSince(key: string, windowMs: number, now = Date.now()) {
  return prisma.loginAttempt.count({
    where: { key, createdAt: { gte: new Date(now - windowMs) } },
  });
}

export async function releaseAttempts(ids: readonly string[]) {
  if (ids.length) await prisma.loginAttempt.deleteMany({ where: { id: { in: [...ids] } } });
}

export async function reserveAttempts(
  limits: readonly AttemptLimit[],
  code: "RATE_LIMITED" | "SECOND_FACTOR_LOCKED" = "RATE_LIMITED",
): Promise<string[]> {
  const ids: string[] = [];
  try {
    for (const { key, limit, windowMs } of limits) {
      const row = await prisma.loginAttempt.create({ data: { key }, select: { id: true } });
      ids.push(row.id);
      if ((await attemptsSince(key, windowMs)) > limit) throw new AuthError(code);
    }
  } catch (error) {
    await releaseAttempts(ids);
    throw error;
  }
  return ids;
}

export async function assertRequestRate(key: string, limit: number, windowMs: number) {
  if (!(await allowRequest(key, limit, windowMs))) throw new AuthError("RATE_LIMITED");
}

export async function checkAccountThrottle(key: string): Promise<{
  blocked: boolean;
  retryAfterSeconds: number;
}> {
  const failed = await attemptsSince(key, LOGIN_ATTEMPT_WINDOW_MS);
  if (failed < MAX_FAILURES) return { blocked: false, retryAfterSeconds: 0 };
  return { blocked: true, retryAfterSeconds: LOGIN_ATTEMPT_WINDOW_MS / 1000 };
}

export async function recordFailedAttempt(key: string) {
  await prisma.loginAttempt.create({ data: { key } });
}

export async function consumeQuota(key: string, limit: number, windowMs: number): Promise<boolean> {
  try {
    await reserveAttempts([{ key, limit, windowMs }]);
    return true;
  } catch (error) {
    if (error instanceof AuthError) return false;
    throw error;
  }
}

export async function clearFailedAttempts(key: string) {
  await prisma.loginAttempt.deleteMany({ where: { key } });
}

export async function secondFactorThrottle(
  userId: string,
): Promise<{ blocked: boolean; retryAfterSeconds: number }> {
  const now = Date.now();
  let retryAfterSeconds = 0;
  for (const window of SECOND_FACTOR_WINDOWS) {
    const since = new Date(now - window.ms);
    const failures = await prisma.loginAttempt.findMany({
      where: { key: secondFactorKey(userId), createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: window.limit,
      select: { createdAt: true },
    });
    if (failures.length >= window.limit) {
      const oldest = failures[failures.length - 1].createdAt.getTime();
      retryAfterSeconds = Math.max(
        retryAfterSeconds,
        Math.ceil((oldest + window.ms - now) / 1000),
      );
    }
  }
  return { blocked: retryAfterSeconds > 0, retryAfterSeconds };
}

export async function reserveSecondFactorAttempt(userId: string): Promise<string[]> {
  const key = secondFactorKey(userId);
  const ids = await reserveAttempts(
    [{ key, limit: SECOND_FACTOR_WINDOWS[0].limit, windowMs: SECOND_FACTOR_WINDOWS[0].ms }],
    "SECOND_FACTOR_LOCKED",
  );
  for (const window of SECOND_FACTOR_WINDOWS.slice(1)) {
    if ((await attemptsSince(key, window.ms)) > window.limit) {
      await releaseAttempts(ids);
      throw new AuthError("SECOND_FACTOR_LOCKED");
    }
  }
  return ids;
}

export async function secondFactorLockReached(userId: string): Promise<boolean> {
  const now = Date.now();
  for (const window of SECOND_FACTOR_WINDOWS) {
    if ((await attemptsSince(secondFactorKey(userId), window.ms, now)) >= window.limit) return true;
  }
  return false;
}

export async function clearSecondFactorFailures(userId: string) {
  await prisma.loginAttempt.deleteMany({ where: { key: secondFactorKey(userId) } });
}
