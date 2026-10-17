import "server-only";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import type { Prisma } from "@/generated/prisma/client";
import type { AuthenticatedSession } from "@/types/auth";

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
