import "server-only";
import { AuthError } from "@/lib/auth/errors";
import { requireActor } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { assertPlatform } from "@/lib/auth/scope";
import type { Prisma } from "@/generated/prisma/client";
import type { AuthenticatedSession } from "@/types/auth";

export function seesMcp(session: Pick<AuthenticatedSession, "permissions">): boolean {
  return hasPerm(session.permissions, PERMISSIONS.SETTINGS_READ) || hasPerm(session.permissions, PERMISSIONS.MCP_READ);
}

export function managesMcp(session: Pick<AuthenticatedSession, "permissions">): boolean {
  return hasPerm(session.permissions, PERMISSIONS.SETTINGS_MANAGE) || hasPerm(session.permissions, PERMISSIONS.MCP_MANAGE);
}

export function visibleToCompany(company: string): Prisma.McpServerWhereInput {
  return {
    OR: [
      { template: true },
      { global: true },
      { installations: { some: { orgId: company } } },
      {
        assignments: {
          some: {
            OR: [
              { orgId: company },
              { team: { orgId: company } },
              { project: { orgId: company } },
              { member: { orgId: company } },
              { key: { orgId: company } },
            ],
          },
        },
      },
    ],
  };
}

export function managesMcpRules(session: Pick<AuthenticatedSession, "permissions">, company: string | null): boolean {
  return managesMcp(session) || Boolean(company && hasPerm(session.permissions, PERMISSIONS.MCP_INSTALL));
}

export function mcpAccess(session: Pick<AuthenticatedSession, "permissions">, company: string | null) {
  const canManage = !company && managesMcp(session);
  return {
    canManage,
    canInstall: canManage || hasPerm(session.permissions, PERMISSIONS.MCP_INSTALL),
    canAssign: managesMcpRules(session, company),
  };
}

export async function requireMcpManager(): Promise<AuthenticatedSession> {
  const session = await requireActor();
  if (!managesMcp(session)) throw new AuthError("FORBIDDEN");
  assertPlatform(session);
  return session;
}
