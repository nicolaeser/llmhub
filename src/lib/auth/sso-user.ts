import "server-only";
import { randomBytes } from "node:crypto";
import prisma from "@/lib/db/prisma";
import { suspendCredentials } from "@/lib/auth/credentials";
import { sessionUserId } from "@/lib/auth/session";
import { isPrismaCode } from "@/lib/auth/errors";
import { hashPassword } from "@/lib/auth/password";
import { emailDomainAllowed } from "@/lib/auth/oidc-presets";
import {
  applyDirectoryRole,
  directoryOrgId,
  directoryRoleId,
  scimGroupValues,
} from "@/lib/auth/directory-roles";
import { securityEvent } from "@/lib/auth/security-events";
import { refuseIfNoOperators } from "@/lib/bootstrap/operators";
import type { OidcIdentity, OidcSettings, SsoFailure } from "@/types/auth";

const userSelect = { id: true, email: true, blocked: true, isOwner: true, roleId: true } as const;

export class SsoError extends Error {
  constructor(readonly reason: SsoFailure) {
    super(`SSO_${reason.toUpperCase()}`);
    this.name = "SsoError";
  }
}

export async function uniqueUsername(base: string): Promise<string> {
  const cleaned = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const seed = cleaned || "user";
  for (let n = 0; n < 50; n++) {
    const candidate = n === 0 ? seed : `${seed.slice(0, 36)}-${n}`;
    const exists = await prisma.user.findUnique({ where: { username: candidate } });
    if (!exists) return candidate;
  }
  return `${seed.slice(0, 24)}-${randomBytes(4).toString("hex")}`;
}

export async function unusablePassword(): Promise<string> {
  return hashPassword(randomBytes(24).toString("base64url"));
}

async function matchUser(identity: OidcIdentity) {
  const linked = await prisma.userIdentity.findUnique({
    where: { issuer_subject: { issuer: identity.issuer, subject: identity.subject } },
    select: { id: true, user: { select: userSelect } },
  });
  if (linked) return { user: linked.user, identityId: linked.id };
  const provisioned = identity.externalIds.length
    ? await prisma.user.findFirst({ where: { externalId: { in: identity.externalIds } }, select: userSelect })
    : null;
  if (provisioned) return { user: provisioned, identityId: null };
  const byEmail = identity.email
    ? await prisma.user.findUnique({ where: { email: identity.email }, select: userSelect })
    : null;
  return { user: byEmail, identityId: null };
}

async function createSsoUser(email: string, oidc: OidcSettings, roleId: string | null) {
  await refuseIfNoOperators();
  return prisma.user.create({
    data: {
      username: await uniqueUsername(email.split("@")[0] ?? "user"),
      email,
      password: await unusablePassword(),
      roleId,
      orgId: await directoryOrgId(oidc),
    },
    select: userSelect,
  });
}

async function refuseWithoutRole(userId: string | null, ipAddress: string | null): Promise<never> {
  if (userId) {
    const { count } = await prisma.session.deleteMany({ where: { userId } });
    if (count) {
      await prisma.userSecurityEvent.create({
        data: { userId, ...securityEvent("sso", "sessions.revoked", ipAddress) },
      });
    }
    await suspendCredentials(userId, "sso", ipAddress);
  }
  throw new SsoError("no_role");
}

async function linkSsoUser(identity: OidcIdentity, oidc: OidcSettings, ipAddress: string | null) {
  const match = await matchUser(identity);
  if (match.user?.isOwner) throw new SsoError("owner");
  const email = match.user?.email ?? identity.email;
  if (!email) throw new SsoError("email");
  if (!emailDomainAllowed(email, oidc.allowed_domains)) throw new SsoError("domain");
  const appRoles = oidc.app_roles ? (identity.appRoles ?? []) : null;
  const claimed = [...identity.groups, ...(appRoles ?? [])];
  const values = match.user ? [...claimed, ...(await scimGroupValues(match.user.id))] : claimed;
  const roleId = await directoryRoleId(oidc, values, appRoles);
  if (appRoles && !roleId) await refuseWithoutRole(match.user?.id ?? null, ipAddress);
  const user = match.user ?? (await createSsoUser(email, oidc, roleId));
  const managed = appRoles !== null;
  if (match.identityId) {
    await prisma.userIdentity.update({ where: { id: match.identityId }, data: { appRoles: managed, lastLoginAt: new Date() } });
  } else {
    const other = await prisma.userIdentity.findUnique({
      where: { userId_issuer: { userId: user.id, issuer: identity.issuer } },
      select: { id: true },
    });
    if (other) throw new SsoError("conflict");
    await prisma.userIdentity.create({
      data: { userId: user.id, issuer: identity.issuer, subject: identity.subject, appRoles: managed, lastLoginAt: new Date() },
    });
  }
  if (oidc.role_mappings.length || managed) await applyDirectoryRole(user, roleId, "sso", ipAddress);
  return { id: user.id, blocked: user.blocked };
}

export async function sessionHeldBy(sessionCookie: string | undefined, identity: OidcIdentity): Promise<boolean> {
  const userId = await sessionUserId(sessionCookie);
  if (!userId) return false;
  const link = await prisma.userIdentity.findUnique({
    where: { issuer_subject: { issuer: identity.issuer, subject: identity.subject } },
    select: { userId: true },
  });
  return link?.userId === userId;
}

export async function signInWithSso(
  identity: OidcIdentity,
  oidc: OidcSettings,
  ipAddress: string | null,
): Promise<{ id: string; blocked: boolean }> {
  try {
    return await linkSsoUser(identity, oidc, ipAddress);
  } catch (err) {
    if (!isPrismaCode(err, "P2002")) throw err;
    return linkSsoUser(identity, oidc, ipAddress);
  }
}
