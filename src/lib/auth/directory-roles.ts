import "server-only";
import prisma from "@/lib/db/prisma";
import { writeAudit } from "@/lib/audit";
import { oidcIsReady } from "@/lib/auth/oidc";
import { appRoleTemplates, mappedRoleId, providerName } from "@/lib/auth/oidc-presets";
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

async function existingRoleId(id: string | null): Promise<string | null> {
  if (!id) return null;
  const role = await prisma.role.findUnique({ where: { id }, select: { id: true } });
  return role?.id ?? null;
}

async function appRoleTemplateId(appRoles: readonly string[] | null): Promise<string | null> {
  const keys = appRoleTemplates(appRoles ?? []);
  if (!keys.length) return null;
  const roles = await prisma.role.findMany({
    where: { templateKey: { in: keys } },
    select: { id: true, templateKey: true },
  });
  return keys.map((key) => roles.find((role) => role.templateKey === key)?.id).find(Boolean) ?? null;
}

export async function directoryRoleId(
  oidc: OidcSettings,
  values: readonly string[],
  appRoles: readonly string[] | null = null,
): Promise<string | null> {
  return (
    (await existingRoleId(mappedRoleId(oidc.role_mappings, values))) ??
    (await appRoleTemplateId(appRoles)) ??
    (await existingRoleId(oidc.default_role_id)) ??
    (appRoles === null ? templateRoleId("viewer") : null)
  );
}

export function roleProvider(oidc: OidcSettings): string | null {
  if (!oidc.app_roles || !oidcIsReady(oidc)) return null;
  return providerName(oidc) || null;
}

export async function appRoleManagedUserIds(oidc: OidcSettings, userIds?: readonly string[]): Promise<Set<string>> {
  if (!roleProvider(oidc)) return new Set();
  const rows = await prisma.userIdentity.findMany({
    where: {
      appRoles: true,
      issuer: { in: [oidc.issuer, `${oidc.issuer}/`] },
      ...(userIds ? { userId: { in: [...userIds] } } : {}),
    },
    select: { userId: true },
  });
  return new Set(rows.map((row) => row.userId));
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
  appRoles: readonly string[] | null = null,
): Promise<string | null> {
  if (user.isOwner || (!oidc.role_mappings.length && appRoles === null)) return user.roleId;
  return applyDirectoryRole(user, await directoryRoleId(oidc, values, appRoles), actor, ipAddress);
}

export async function applyDirectoryRole(
  user: DirectoryUser,
  roleId: string | null,
  actor: string,
  ipAddress: string | null,
): Promise<string | null> {
  if (user.isOwner || !roleId || roleId === user.roleId) return user.roleId;
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
  const managed = await appRoleManagedUserIds(oidc, users.map((user) => user.id));
  for (const user of users) {
    if (managed.has(user.id)) continue;
    await syncDirectoryRole(user, await scimGroupValues(user.id), oidc, "scim", ipAddress);
  }
}
