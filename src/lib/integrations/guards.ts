import "server-only";
import prisma from "@/lib/db/prisma";
import { writeAudit } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { companyOf } from "@/lib/auth/scope";
import { fail } from "@/lib/integrations/records";
import { sanitizeForLog } from "@/lib/integrations/sanitize";
import { sameCompany } from "@/lib/integrations/scope";
import type { AuthenticatedSession } from "@/types/auth";

export async function reader(): Promise<AuthenticatedSession> {
  return requirePermission(PERMISSIONS.INTEGRATIONS_READ);
}

export async function manager(): Promise<AuthenticatedSession> {
  return requirePermission(PERMISSIONS.INTEGRATIONS_MANAGE);
}

export async function publisher(): Promise<AuthenticatedSession> {
  return requirePermission(PERMISSIONS.INTEGRATIONS_PUBLISH);
}

export async function credentialUser(): Promise<AuthenticatedSession> {
  return requirePermission(PERMISSIONS.INTEGRATIONS_CREDENTIALS);
}

export function assertCompany(session: AuthenticatedSession, orgId: string): void {
  if (!sameCompany(companyOf(session), orgId)) fail("FORBIDDEN");
}

export function orgFor(session: AuthenticatedSession, requested?: string): string {
  const company = companyOf(session);
  if (company) {
    if (requested && requested !== company) fail("FORBIDDEN");
    return company;
  }
  if (!requested) fail("ORG_REQUIRED");
  return requested;
}

export function assertPlatform(session: AuthenticatedSession): void {
  if (companyOf(session)) fail("PLATFORM_ONLY");
}

export async function assertOwner(session: AuthenticatedSession, owner: "blueprint" | "company", ownerId: string): Promise<void> {
  if (owner === "blueprint") {
    assertPlatform(session);
    if (!hasPerm(session.permissions, PERMISSIONS.INTEGRATIONS_PUBLISH)) fail("FORBIDDEN");
    const row = await prisma.integrationBlueprint.findUnique({ where: { id: ownerId }, select: { id: true } });
    if (!row) fail("INTEGRATION_NOT_FOUND");
    return;
  }
  const row = await prisma.companyIntegration.findUnique({ where: { id: ownerId }, select: { orgId: true } });
  if (!row) fail("INTEGRATION_NOT_FOUND");
  assertCompany(session, row.orgId);
}

export async function ownedTool(session: AuthenticatedSession, toolId: string) {
  const tool = await prisma.toolDefinition.findUnique({ where: { id: toolId }, include: { companyIntegration: true } });
  if (!tool) fail("INTEGRATION_NOT_FOUND");
  if (tool.companyIntegration) assertCompany(session, tool.companyIntegration.orgId);
  else assertPlatform(session);
  return tool;
}

export async function audit(session: AuthenticatedSession, action: string, objectId: string, after: unknown): Promise<void> {
  await writeAudit({ actor: session.user.id, action, objectType: "integration", objectId, after: sanitizeForLog(after) });
}
