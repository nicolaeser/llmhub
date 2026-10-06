import "server-only";
import prisma from "@/lib/db/prisma";
import type { SecurityEventAction, SecurityEventView } from "@/types/security";

const securityEventActions = [
  "2fa.enrolled",
  "2fa.replaced",
  "2fa.recovery_regenerated",
  "2fa.recovery_used",
  "2fa.locked",
  "2fa.reset",
  "password.changed",
  "password.reset",
  "password.change_required",
  "sessions.revoked",
  "passkey.added",
  "passkey.removed",
  "role.changed",
  "account.blocked",
  "account.unblocked",
  "management_key.created",
  "management_key.revoked",
] as const satisfies readonly SecurityEventAction[];

export const SYSTEM_ACTOR = "system";

export const userActor = (userId: string) => `user:${userId}`;

const actorUserId = (actor: string) => actor.match(/^user:(.+)$/)?.[1];

export function securityEvent(
  actor: string,
  action: SecurityEventAction,
  ipAddress: string | null = null,
) {
  return { actor, action, ipAddress };
}

export async function recordSecurityEvent(
  userId: string,
  actor: string,
  action: SecurityEventAction,
  ipAddress: string | null = null,
) {
  await prisma.userSecurityEvent.create({
    data: { userId, ...securityEvent(actor, action, ipAddress) },
  });
}

export async function securityEventViews(
  userId: string,
  take: number,
): Promise<SecurityEventView[]> {
  const rows = await prisma.userSecurityEvent.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take,
    select: { id: true, actor: true, action: true, createdAt: true },
  });
  const otherIds = [
    ...new Set(
      rows
        .map((row) => actorUserId(row.actor))
        .filter((id): id is string => Boolean(id) && id !== userId),
    ),
  ];
  const names = new Map(
    (otherIds.length
      ? await prisma.user.findMany({
          where: { id: { in: otherIds } },
          select: { id: true, username: true },
        })
      : []
    ).map((row) => [row.id, row.username]),
  );
  return rows.flatMap((row) => {
    const action = securityEventActions.find((known) => known === row.action);
    if (!action) return [];
    const actorId = actorUserId(row.actor);
    const self = actorId === userId;
    return [
      {
        id: row.id,
        action,
        actor: self ? "self" : actorId ? "user" : "system",
        actorName: actorId && !self ? (names.get(actorId) ?? null) : null,
        createdAt: row.createdAt.toISOString(),
      },
    ];
  });
}
