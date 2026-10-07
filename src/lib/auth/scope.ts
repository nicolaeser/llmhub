import "server-only";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import type { AuthenticatedSession } from "@/types/auth";
import type { SpendScope } from "@/types/structure";

export function seesAllResources(session: AuthenticatedSession): boolean {
  return hasPerm(session.permissions, PERMISSIONS.KEYS_READ_ALL);
}

export function seesAllSpend(session: AuthenticatedSession): boolean {
  return hasPerm(session.permissions, PERMISSIONS.SPEND_READ_ALL);
}

export function companyOf(session: AuthenticatedSession): string | null {
  if (session.isOwner) return null;
  return session.user.orgId ?? null;
}

export function inCompany(session: AuthenticatedSession, orgId: string | null | undefined): boolean {
  const company = companyOf(session);
  return !company || orgId === company;
}

export function keyScope(session: AuthenticatedSession): { orgId?: string; userId?: string } {
  const company = companyOf(session);
  return {
    ...(company ? { orgId: company } : {}),
    ...(seesAllResources(session) ? {} : { userId: session.user.id }),
  };
}

export function spendScope(session: AuthenticatedSession): SpendScope {
  const company = companyOf(session);
  return {
    ...(company ? { orgId: company } : {}),
    ...(seesAllSpend(session) ? {} : { userId: session.user.id }),
  };
}

export function keyVisibleTo(
  session: AuthenticatedSession,
  key: { userId: string | null; orgId: string | null },
): boolean {
  if (!inCompany(session, key.orgId)) return false;
  if (seesAllResources(session)) return true;
  return key.userId === session.user.id;
}
