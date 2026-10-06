import "server-only";
import prisma from "@/lib/db/prisma";
import { SESSION_IDLE_TTL_MS } from "@/lib/auth/cookie";
import type { AuthCleanupResult } from "@/types/security";

const HOUR_MS = 60 * 60 * 1000;
const PENDING_ENROLLMENT_TTL_MS = 24 * HOUR_MS;

export async function purgeAuthRecords(now = new Date()): Promise<AuthCleanupResult> {
  const at = now.getTime();
  const [sessions, challenges, ceremonies, enrollments] = await Promise.all([
    prisma.session.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: now } },
          { lastActive: { lt: new Date(at - SESSION_IDLE_TTL_MS) } },
        ],
      },
    }),
    prisma.loginChallenge.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: now } }, { consumedAt: { lt: new Date(at - HOUR_MS) } }],
      },
    }),
    prisma.authCeremony.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.userTotp.updateMany({
      where: { pendingAt: { lt: new Date(at - PENDING_ENROLLMENT_TTL_MS) } },
      data: { pendingSecret: null, pendingAt: null },
    }),
  ]);
  await prisma.userTotp.deleteMany({ where: { enabledAt: null, pendingSecret: null } });
  return {
    sessions: sessions.count,
    challenges: challenges.count,
    ceremonies: ceremonies.count,
    enrollments: enrollments.count,
  };
}
