import "server-only";
import prisma from "@/lib/db/prisma";
import { writeAudit } from "@/lib/audit";
import { AuthError } from "@/lib/auth/errors";
import { securityEvent, userActor } from "@/lib/auth/security-events";
import type { AuthenticatedSession } from "@/types/auth";

export async function suspendCredentials(userId: string, actor: string, ipAddress: string | null): Promise<boolean> {
  const { count } = await prisma.user.updateMany({
    where: { id: userId, isOwner: false, credentialsSuspendedAt: null },
    data: { credentialsSuspendedAt: new Date(), revision: { increment: 1 } },
  });
  if (!count) return false;
  await prisma.userSecurityEvent.create({ data: { userId, ...securityEvent(actor, "credentials.suspended", ipAddress) } });
  await writeAudit({ actor, action: "user.credentials_suspended", objectType: "user", objectId: userId });
  return true;
}

export async function restoreCredentials(userId: string, actorId: string, ipAddress: string | null): Promise<boolean> {
  const { count } = await prisma.user.updateMany({
    where: { id: userId, credentialsSuspendedAt: { not: null } },
    data: { credentialsSuspendedAt: null, revision: { increment: 1 } },
  });
  if (!count) return false;
  await prisma.userSecurityEvent.create({
    data: { userId, ...securityEvent(userActor(actorId), "credentials.restored", ipAddress) },
  });
  await writeAudit({ actor: actorId, action: "user.credentials_restored", objectType: "user", objectId: userId });
  return true;
}

export async function canRestoreOwnCredentials(session: AuthenticatedSession): Promise<boolean> {
  const suspendedAt = session.user.credentialsSuspendedAt;
  if (!suspendedAt || session.secondFactor !== "SSO" || !session.role) return false;
  const current = await prisma.session.findUnique({ where: { id: session.sessionId }, select: { createdAt: true } });
  return Boolean(current && current.createdAt > suspendedAt);
}

export async function restoreOwnCredentials(session: AuthenticatedSession): Promise<void> {
  if (!(await canRestoreOwnCredentials(session))) throw new AuthError("FORBIDDEN");
  await restoreCredentials(session.user.id, session.user.id, session.ipAddress);
}
