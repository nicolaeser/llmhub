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
  if (session.isOwner) return session.workspaceOrgId || null;
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

export function spendScopeFor(input: { company: string | null; seesAll: boolean; userId: string }): SpendScope {
  return {
    ...(input.company ? { orgId: input.company } : {}),
    ...(input.seesAll ? {} : { userId: input.userId }),
  };
}

export function spendScope(session: AuthenticatedSession): SpendScope {
  return spendScopeFor({ company: companyOf(session), seesAll: seesAllSpend(session), userId: session.user.id });
}

export function spendScopeKey(scope: SpendScope): string {
  return `${scope.orgId ?? ""}|${scope.userId ?? ""}`;
}

export function keyVisibleTo(
  session: AuthenticatedSession,
  key: { userId: string | null; orgId: string | null },
): boolean {
  if (!inCompany(session, key.orgId)) return false;
  if (seesAllResources(session)) return true;
  return key.userId === session.user.id;
}
