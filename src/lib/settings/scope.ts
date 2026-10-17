import "server-only";
import prisma from "@/lib/db/prisma";
import { requirePermission } from "@/lib/auth/guards";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { companyOf } from "@/lib/auth/scope";
import type { SettingsScope } from "@/types/settings";

export async function loadSettingsScope(): Promise<SettingsScope> {
  const session = await requirePermission(PERMISSIONS.SETTINGS_READ);
  const company = companyOf(session);
  const org = company ? await prisma.organization.findUnique({ where: { id: company }, select: { id: true, alias: true } }) : null;
  return { company: org, platform: !(session.isOwner && org) };
}
