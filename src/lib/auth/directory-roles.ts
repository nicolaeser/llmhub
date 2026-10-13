import "server-only";
import prisma from "@/lib/db/prisma";
import { writeAudit } from "@/lib/audit";
import { mappedRoleId } from "@/lib/auth/oidc-presets";
import { templateRoleId } from "@/lib/auth/roles";
import { securityEvent } from "@/lib/auth/security-events";
import { getEnterprise, normalizeOidc } from "@/lib/settings/enterprise";
import type { OidcSettings } from "@/types/auth";

type DirectoryUser = { id: string; isOwner: boolean; roleId: string | null };

export async function scimGroupValues(userId: string): Promise<string[]> {
  const rows = await prisma.scimGroupMember.findMany({
    where: { userId },
    select: { group: { select: { displayName: true, externalId: true } } },
  });
  return rows.flatMap((row) => [row.group.displayName, row.group.externalId ?? ""]).filter(Boolean);
}

export async function directoryRoleId(oidc: OidcSettings, values: readonly string[]): Promise<string | null> {
  for (const id of [mappedRoleId(oidc.role_mappings, values), oidc.default_role_id]) {
    if (!id) continue;
    const role = await prisma.role.findUnique({ where: { id }, select: { id: true } });
    if (role) return role.id;
  }
  return templateRoleId("viewer");
}

export async function directoryOrgId(oidc: OidcSettings): Promise<string | null> {
  if (!oidc.default_org_id) return null;
  const org = await prisma.organization.findUnique({ where: { id: oidc.default_org_id }, select: { id: true } });
  return org?.id ?? null;
}

export async function syncDirectoryRole(
  user: DirectoryUser,
  values: readonly string[],
  oidc: OidcSettings,
  actor: string,
  ipAddress: string | null,
): Promise<string | null> {
  if (user.isOwner || !oidc.role_mappings.length) return user.roleId;
  const roleId = await directoryRoleId(oidc, values);
  if (!roleId || roleId === user.roleId) return user.roleId;
  await prisma.user.update({
    where: { id: user.id, isOwner: false },
    data: {
      roleId,
      revision: { increment: 1 },
      securityEvents: { create: securityEvent(actor, "role.changed", ipAddress) },
    },
  });
  await writeAudit({
    actor,
    action: "user.role_synced",
    objectType: "user",
    objectId: user.id,
    before: { roleId: user.roleId },
    after: { roleId },
  });
  return roleId;
}

export async function syncScimRoles(userIds: readonly string[], ipAddress: string | null): Promise<void> {
  if (!userIds.length) return;
  const oidc = normalizeOidc((await getEnterprise()).oidc);
  if (!oidc.role_mappings.length) return;
  const users = await prisma.user.findMany({
    where: { id: { in: [...new Set(userIds)] } },
    select: { id: true, isOwner: true, roleId: true },
  });
  for (const user of users) {
    await syncDirectoryRole(user, await scimGroupValues(user.id), oidc, "scim", ipAddress);
  }
}
