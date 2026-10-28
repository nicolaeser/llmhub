import "server-only";
import prisma from "@/lib/db/prisma";
import { writeAudit } from "@/lib/audit";
import { applyDirectoryRole, directoryRoleId, scimGroupValues } from "@/lib/auth/directory-roles";
import { oidcIsReady, refreshOidcGrant, resolveOidc, verifyLogoutToken } from "@/lib/auth/oidc";
import { securityEvent } from "@/lib/auth/security-events";
import { open, seal } from "@/lib/crypto";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { getEnterprise, normalizeOidc } from "@/lib/settings/enterprise";
import type { OidcGrant, OidcSettings } from "@/types/auth";

export const SSO_REVALIDATE_INTERVAL_MS = 5 * 60_000;
const SSO_REVALIDATE_BATCH = 100;
const SSO_ACTOR = "sso";

type AccessUser = { id: string; isOwner: boolean; roleId: string | null };

export async function recordSsoSession(sessionId: string, grant: OidcGrant): Promise<void> {
  await prisma.ssoSession.create({
    data: {
      sessionId,
      issuer: grant.identity.issuer,
      subject: grant.identity.subject,
      sid: grant.sid || null,
      refreshToken: grant.refreshToken ? seal(grant.refreshToken) : null,
    },
  });
}

async function sessionsRevoked(userId: string): Promise<void> {
  await prisma.userSecurityEvent.create({ data: { userId, ...securityEvent(SSO_ACTOR, "sessions.revoked", null) } });
}

export async function endProviderAccess(user: AccessUser, oidc: OidcSettings): Promise<number> {
  const { count: ended } = await prisma.session.deleteMany({ where: { userId: user.id } });
  if (ended) await sessionsRevoked(user.id);
  if (!oidc.app_roles || user.isOwner || !user.roleId) return ended;
  await prisma.user.update({
    where: { id: user.id, isOwner: false },
    data: {
      roleId: null,
      revision: { increment: 1 },
      securityEvents: { create: securityEvent(SSO_ACTOR, "role.changed", null) },
    },
  });
  await writeAudit({
    actor: SSO_ACTOR,
    action: "user.role_synced",
    objectType: "user",
    objectId: user.id,
    before: { roleId: user.roleId },
    after: { roleId: null },
  });
  return ended;
}

export async function backchannelLogout(logoutToken: string, fetchFn: typeof fetch = fetch): Promise<number> {
  const oidc = normalizeOidc((await getEnterprise()).oidc);
  if (!oidcIsReady(oidc)) throw new Error("oidc not configured");
  const logout = await verifyLogoutToken(resolveOidc(oidc), logoutToken, fetchFn);
  const rows = await prisma.ssoSession.findMany({
    where: {
      issuer: logout.issuer,
      ...(logout.subject ? { subject: logout.subject } : {}),
      ...(logout.sid ? { sid: logout.sid } : {}),
    },
    select: { sessionId: true, session: { select: { userId: true } } },
  });
  if (!rows.length) return 0;
  const { count } = await prisma.session.deleteMany({ where: { id: { in: rows.map((row) => row.sessionId) } } });
  for (const userId of new Set(rows.map((row) => row.session.userId))) await sessionsRevoked(userId);
  return count;
}

async function applyRefreshedRole(
  oidc: OidcSettings,
  user: AccessUser,
  refreshed: { groups: string[] | null; appRoles: string[] | null },
): Promise<number> {
  if (!oidc.app_roles || !refreshed.groups) return 0;
  const appRoles = refreshed.appRoles ?? [];
  const values = [...refreshed.groups, ...appRoles, ...(await scimGroupValues(user.id))];
  const roleId = await directoryRoleId(oidc, values, appRoles);
  if (!roleId) return endProviderAccess(user, oidc);
  user.roleId = await applyDirectoryRole(user, roleId, SSO_ACTOR, null);
  return 0;
}

export async function revalidateSsoSessions(now = new Date(), fetchFn: typeof fetch = fetch): Promise<number> {
  const oidc = normalizeOidc((await getEnterprise()).oidc);
  if (!oidcIsReady(oidc)) return 0;
  const due = await prisma.ssoSession.findMany({
    where: {
      refreshToken: { not: null },
      checkedAt: { lt: new Date(now.getTime() - SSO_REVALIDATE_INTERVAL_MS) },
      session: { expiresAt: { gt: now } },
    },
    orderBy: { checkedAt: "asc" },
    take: SSO_REVALIDATE_BATCH,
    select: {
      id: true,
      subject: true,
      refreshToken: true,
      session: { select: { user: { select: { id: true, isOwner: true, roleId: true } } } },
    },
  });
  const resolved = resolveOidc(oidc);
  const users = new Map<string, AccessUser>();
  const gone = new Set<string>();
  let ended = 0;
  for (const row of due) {
    if (gone.has(row.session.user.id)) continue;
    const user = users.get(row.session.user.id) ?? { ...row.session.user };
    users.set(user.id, user);
    try {
      const refreshed = await refreshOidcGrant({
        resolved,
        refreshToken: open(row.refreshToken ?? ""),
        subject: row.subject,
        fetchFn,
      });
      if (refreshed.status === "refused") {
        ended += await endProviderAccess(user, oidc);
        gone.add(user.id);
        continue;
      }
      await prisma.ssoSession.update({
        where: { id: row.id },
        data: { refreshToken: seal(refreshed.refreshToken), checkedAt: now },
      });
      const revoked = await applyRefreshedRole(oidc, user, refreshed);
      if (revoked) gone.add(user.id);
      ended += revoked;
    } catch (err) {
      logger.warn("sso.revalidate_failed", errorFields(err));
      await prisma.ssoSession.updateMany({ where: { id: row.id }, data: { checkedAt: now } });
    }
  }
  return ended;
}
