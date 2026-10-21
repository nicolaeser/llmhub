import "server-only";
import prisma from "@/lib/db/prisma";
import { requireSession } from "@/lib/auth/guards";
import { accessKey } from "@/lib/auth/permissions";
import { companyOf } from "@/lib/auth/scope";
import type { AuthenticatedSession } from "@/types/auth";
import type { ConsoleAccess, ConsoleScopeState, ScopeCompany } from "@/types/console";

const COMPANY_SELECT = { id: true, alias: true } as const;

export async function consoleScopeOf(session: AuthenticatedSession): Promise<ConsoleScopeState> {
  const companyId = companyOf(session);
  const companies: ScopeCompany[] = session.isOwner
    ? await prisma.organization.findMany({ select: COMPANY_SELECT, orderBy: { alias: "asc" } })
    : [];
  const company = companyId
    ? (companies.find((row) => row.id === companyId) ??
      (await prisma.organization.findUnique({ where: { id: companyId }, select: COMPANY_SELECT })))
    : null;
  return {
    scope: company ? { kind: "company", id: company.id, alias: company.alias } : { kind: "platform" },
    companies,
    canSwitch: session.isOwner,
  };
}

export async function loadConsoleScope(): Promise<ConsoleScopeState> {
  return consoleScopeOf(await requireSession());
}

export function sessionAccessKey(session: AuthenticatedSession): string {
  return accessKey({ isOwner: session.isOwner, orgId: session.user.orgId, permissions: session.permissions });
}

export async function loadConsoleAccess(): Promise<ConsoleAccess> {
  return { key: sessionAccessKey(await requireSession()) };
}
