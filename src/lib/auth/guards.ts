import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE } from "@/lib/auth/cookie";
import { delegatedPrincipal } from "@/lib/auth/delegation";
import { AuthError } from "@/lib/auth/errors";
import { getSession } from "@/lib/auth/session";
import { hasPerm } from "@/lib/auth/permissions";
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

export async function requirePermission(
  permission: Permission,
): Promise<AuthenticatedSession> {
  const session = delegatedPrincipal() ?? (await requireSession());
  if (!hasPerm(session.permissions, permission)) {
    throw new AuthError("FORBIDDEN");
  }
  return session;
}
