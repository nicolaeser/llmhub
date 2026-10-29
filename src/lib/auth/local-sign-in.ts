import "server-only";
import { after } from "next/server";
import prisma from "@/lib/db/prisma";
import { fireAlert } from "@/lib/alerts/notify";
import { writeAudit } from "@/lib/audit";
import { AuthError } from "@/lib/auth/errors";
import { oidcIsReady, ssoOnlyActive } from "@/lib/auth/oidc";
import { effectivePermissions, hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { securityEvent, userActor } from "@/lib/auth/security-events";
import { env } from "@/lib/env";
import { logger } from "@/lib/logging/logger";
import { mailErrorCode, sendMail } from "@/lib/mail/send";
import { getEnterprise, normalizeOidc } from "@/lib/settings/enterprise";
import type { LocalSignInPolicy, OidcSettings } from "@/types/auth";
import type { SessionFactor } from "@/types/security";

export const EMERGENCY_ACCESS_LIMIT = 3;

type LocalAccount = { id: string; isOwner: boolean; emergencyAccess: boolean; externalId: string | null };
type SignedInAccount = { id: string; username: string; email: string };

export function localSignInPolicy(oidc: OidcSettings): LocalSignInPolicy {
  return {
    ssoOnly: ssoOnlyActive(oidc),
    rolesFromProvider: oidc.app_roles && oidcIsReady(oidc),
    issuers: [oidc.issuer, `${oidc.issuer}/`],
  };
}

export async function currentLocalSignInPolicy(): Promise<LocalSignInPolicy> {
  return localSignInPolicy(normalizeOidc((await getEnterprise()).oidc));
}

export function localSignInRestricted(policy: LocalSignInPolicy): boolean {
  return policy.ssoOnly || policy.rolesFromProvider;
}

export function localSignInAllowed(
  account: Pick<LocalAccount, "isOwner" | "emergencyAccess">,
  linked: boolean,
  policy: LocalSignInPolicy,
): boolean {
  if (account.isOwner || account.emergencyAccess) return true;
  if (policy.ssoOnly) return false;
  return !(policy.rolesFromProvider && linked);
}

export function hasEmergencyAccess(
  account: Pick<LocalAccount, "isOwner" | "emergencyAccess">,
  linked: boolean,
  policy: LocalSignInPolicy,
): boolean {
  return localSignInRestricted(policy) && localSignInAllowed(account, linked, policy);
}

export async function providerLinkedUserIds(policy: LocalSignInPolicy, userIds?: readonly string[]): Promise<Set<string>> {
  const scope = userIds ? { in: [...userIds] } : undefined;
  const [identities, provisioned] = await Promise.all([
    prisma.userIdentity.findMany({
      where: { issuer: { in: policy.issuers }, ...(scope ? { userId: scope } : {}) },
      select: { userId: true },
    }),
    prisma.user.findMany({ where: { externalId: { not: null }, ...(scope ? { id: scope } : {}) }, select: { id: true } }),
  ]);
  return new Set([...identities.map((row) => row.userId), ...provisioned.map((row) => row.id)]);
}

export async function localSignInAccess(account: LocalAccount): Promise<boolean> {
  const policy = await currentLocalSignInPolicy();
  if (!localSignInRestricted(policy)) return false;
  const linked = (await providerLinkedUserIds(policy, [account.id])).has(account.id);
  if (!localSignInAllowed(account, linked, policy)) throw new AuthError("SSO_REQUIRED");
  return true;
}

export async function localSessionRefused(account: LocalAccount & { identities: { issuer: string }[] }): Promise<boolean> {
  if (account.isOwner || account.emergencyAccess || (!account.externalId && !account.identities.length)) return false;
  const policy = await currentLocalSignInPolicy();
  const linked = Boolean(account.externalId) || account.identities.some((identity) => policy.issuers.includes(identity.issuer));
  return !localSignInAllowed(account, linked, policy);
}

async function adminRecipients(excludeUserId: string): Promise<string[]> {
  const users = await prisma.user.findMany({
    where: { blocked: false, id: { not: excludeUserId } },
    select: { email: true, isOwner: true, orgId: true, role: { select: { permissions: true } } },
  });
  return users
    .filter((user) =>
      hasPerm(
        effectivePermissions({ isOwner: user.isOwner, rolePermissions: user.role?.permissions ?? [], orgId: user.orgId }),
        PERMISSIONS.USERS_MANAGE,
      ),
    )
    .map((user) => user.email);
}

async function notifyEmergencySignIn(account: SignedInAccount, ipAddress: string | null): Promise<void> {
  const who = `${account.username} (${account.email})`;
  await fireAlert("emergency_sign_in", `${who} signed in locally with emergency access instead of the identity provider`);
  const recipients = await adminRecipients(account.id);
  if (!recipients.length) return;
  try {
    const result = await sendMail({
      to: recipients,
      subject: "Emergency sign-in to LLM Hub",
      text: [
        `${who} signed in with a local password or passkey instead of the identity provider.`,
        `IP address: ${ipAddress ?? "unknown"}`,
        "",
        "If you did not expect this, block the account on the users page:",
        new URL("/users", env.NEXT_PUBLIC_APP_URL).toString(),
      ].join("\n"),
    });
    if (!result.sent) logger.info("auth.emergency_sign_in.mail_skipped", { userId: account.id });
  } catch (err) {
    logger.warn("auth.emergency_sign_in.mail_failed", { userId: account.id, error: mailErrorCode(err) });
  }
}

export async function recordEmergencySignIn(
  account: SignedInAccount,
  method: SessionFactor,
  ipAddress: string | null,
): Promise<void> {
  await prisma.userSecurityEvent.create({
    data: { userId: account.id, ...securityEvent(userActor(account.id), "emergency_access.sign_in", ipAddress) },
  });
  await writeAudit({
    actor: account.id,
    action: "user.emergency_sign_in",
    objectType: "user",
    objectId: account.id,
    after: { method },
  });
  logger.warn("auth.emergency_sign_in", { userId: account.id, method });
  after(() => notifyEmergencySignIn(account, ipAddress));
}
