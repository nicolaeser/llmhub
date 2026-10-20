import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE } from "@/lib/auth/cookie";
import { delegatedPrincipal } from "@/lib/auth/delegation";
import { AuthError } from "@/lib/auth/errors";
import { getSession } from "@/lib/auth/session";
import { hasPerm } from "@/lib/auth/permissions";
import { assertPlatform, companyOf } from "@/lib/auth/scope";
import type { AuthenticatedSession, Permission } from "@/types/auth";

export async function requireAuth(): Promise<AuthenticatedSession> {
  const session = await getSession();
  if (session.error) {
    const stale = (await cookies()).has(SESSION_COOKIE);
    redirect(stale ? "/internal-api/account/expired" : "/account/login");
  }
  return session;
}

export async function requireSession(): Promise<AuthenticatedSession> {
  const session = await getSession();
  if (session.error) throw new Error("Unauthorized");
  return session;
}

/** Console cookie session, or the principal already bound by runAsPrincipal. */
export async function requireActor(): Promise<AuthenticatedSession> {
  return delegatedPrincipal() ?? requireSession();
}

export async function requirePermission(
  permission: Permission,
): Promise<AuthenticatedSession> {
  const session = await requireActor();
  if (!hasPerm(session.permissions, permission)) {
    throw new AuthError("FORBIDDEN");
  }
  return session;
}

export async function requirePlatformPermission(permission: Permission): Promise<AuthenticatedSession> {
  const session = await requirePermission(permission);
  assertPlatform(session);
  return session;
}

export async function requirePlatformScope(): Promise<AuthenticatedSession> {
  const session = await requireAuth();
  if (companyOf(session)) redirect("/");
  return session;
}

export async function grantedPermissions(wanted: readonly Permission[]): Promise<Permission[]> {
  const session = await requireSession();
  return wanted.filter((permission) => hasPerm(session.permissions, permission));
}
