import "server-only";
import { AuthError } from "@/lib/auth/errors";
import { isSubset } from "@/lib/auth/permissions";
import type { AuthenticatedSession, GrantActor, Permission } from "@/types/auth";

export function grantActor(session: AuthenticatedSession): GrantActor {
  return { isOwner: session.isOwner, permissions: session.permissions };
}

export function canGrant(actor: GrantActor, permissions: readonly Permission[]): boolean {
  return actor.isOwner || isSubset(permissions, actor.permissions);
}

export function assertCanGrant(actor: GrantActor, permissions: readonly Permission[]): void {
  if (!canGrant(actor, permissions)) throw new AuthError("INVALID_SCOPE");
}

export function canManage(actor: GrantActor, current: readonly Permission[]): boolean {
  return actor.isOwner || isSubset(current, actor.permissions);
}

export function assertCanManage(
  actor: GrantActor,
  current: readonly Permission[],
  code: "ROLE_PROTECTED" | "USER_PROTECTED",
): void {
  if (!canManage(actor, current)) throw new AuthError(code);
}
