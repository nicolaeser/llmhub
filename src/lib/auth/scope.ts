import "server-only";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import type { AuthenticatedSession } from "@/types/auth";

export function seesAllResources(session: AuthenticatedSession): boolean {
  return hasPerm(session.permissions, PERMISSIONS.KEYS_READ_ALL);
}

export function seesAllSpend(session: AuthenticatedSession): boolean {
  return hasPerm(session.permissions, PERMISSIONS.SPEND_READ_ALL);
}

export function keyVisibleTo(
  session: AuthenticatedSession,
  keyUserId: string | null,
): boolean {
  if (seesAllResources(session)) return true;
  return keyUserId === session.user.id;
}
