import "server-only";
import { cookies } from "next/headers";
import prisma from "@/lib/db/prisma";
import { AuthError } from "@/lib/auth/errors";
import { CHALLENGE_COOKIE, ceremonyCookieOptions } from "@/lib/auth/cookie";
import { digest, randomToken } from "@/lib/crypto";
import type { ChallengePurpose, LoginChallengeRecord, SecondFactorMethod } from "@/types/security";

const CHALLENGE_TTL_MS: Record<ChallengePurpose, number> = {
  VERIFY: 5 * 60 * 1000,
  ENROLL: 15 * 60 * 1000,
  PASSWORD: 10 * 60 * 1000,
};

const MAX_CHALLENGE_ATTEMPTS = 5;

export const challengeExpired = () => new AuthError("LOGIN_CHALLENGE_EXPIRED");

async function setChallengeCookie(token: string, expiresAt: Date) {
  const opts = ceremonyCookieOptions(CHALLENGE_COOKIE, expiresAt);
  (await cookies()).set(opts.name, token, opts);
}

export async function issueLoginChallenge(
  userId: string,
  purpose: ChallengePurpose,
  factor?: SecondFactorMethod,
) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS[purpose]);
  await prisma.loginChallenge.deleteMany({ where: { userId, consumedAt: null } });
  await prisma.loginChallenge.create({
    data: {
      userId,
      tokenHash: digest(token),
      purpose,
      factor: factor ?? null,
      expiresAt,
    },
  });
  await setChallengeCookie(token, expiresAt);
  return { expiresAt };
}

export async function currentLoginChallenge(
  purpose?: ChallengePurpose,
): Promise<LoginChallengeRecord> {
  const token = (await cookies()).get(CHALLENGE_COOKIE)?.value;
  if (!token) throw challengeExpired();
  const challenge = await prisma.loginChallenge.findUnique({
    where: { tokenHash: digest(token) },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          username: true,
          blocked: true,
          mustChangePassword: true,
        },
      },
    },
  });
  if (
    !challenge ||
    challenge.consumedAt ||
    challenge.expiresAt <= new Date() ||
    challenge.attempts >= MAX_CHALLENGE_ATTEMPTS ||
    challenge.user.blocked ||
    (purpose && challenge.purpose !== purpose)
  ) {
    throw challengeExpired();
  }
  return challenge;
}

export async function reserveChallengeAttempt(id: string) {
  const { count } = await prisma.loginChallenge.updateMany({
    where: {
      id,
      consumedAt: null,
      expiresAt: { gt: new Date() },
      attempts: { lt: MAX_CHALLENGE_ATTEMPTS },
    },
    data: { attempts: { increment: 1 } },
  });
  if (count !== 1) throw challengeExpired();
}

export async function consumeLoginChallenge(id: string) {
  const { count } = await prisma.loginChallenge.updateMany({
    where: { id, consumedAt: null, expiresAt: { gt: new Date() } },
    data: { consumedAt: new Date() },
  });
  if (count !== 1) throw challengeExpired();
}

export async function advanceToPasswordStep(
  id: string,
  from: ChallengePurpose,
  factor: SecondFactorMethod,
) {
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS.PASSWORD);
  const { count } = await prisma.loginChallenge.updateMany({
    where: { id, purpose: from, consumedAt: null, expiresAt: { gt: new Date() } },
    data: {
      purpose: "PASSWORD",
      factor,
      attempts: 0,
      webauthnChallenge: null,
      expiresAt,
    },
  });
  if (count !== 1) throw challengeExpired();
  const token = (await cookies()).get(CHALLENGE_COOKIE)?.value;
  if (token) await setChallengeCookie(token, expiresAt);
  return { expiresAt };
}

export async function clearLoginChallenge() {
  const store = await cookies();
  const token = store.get(CHALLENGE_COOKIE)?.value;
  if (token) {
    await prisma.loginChallenge.deleteMany({ where: { tokenHash: digest(token) } });
  }
  store.set({ ...ceremonyCookieOptions(CHALLENGE_COOKIE, new Date(0)), value: "" });
}
