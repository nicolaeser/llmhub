import "server-only";
import { cookies, headers } from "next/headers";
import prisma from "@/lib/db/prisma";
import { effectivePermissions } from "@/lib/auth/permissions";
import { digest, randomToken } from "@/lib/crypto";
import { clientIp } from "@/lib/http/api";
import {
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_COOKIE,
  SESSION_IDLE_TTL_MS,
  sessionCookieOptions,
  signSessionToken,
  verifySessionCookie,
} from "@/lib/auth/cookie";
import type { RequestMeta, SessionResult } from "@/types/auth";
import type { SessionFactor } from "@/types/security";

const MAX_SESSIONS = 10;
const ACTIVITY_WRITE_INTERVAL_MS = 60_000;

export function newSessionToken(now = new Date()) {
  const token = randomToken();
  return {
    token,
    tokenHash: digest(token),
    expiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_TTL_MS),
  };
}

export async function requestMeta(): Promise<RequestMeta> {
  const h = await headers();
  return { ipAddress: clientIp(h) || null, userAgent: h.get("user-agent")?.slice(0, 512) ?? null };
}

export async function pruneSessions(userId: string): Promise<void> {
  const rows = await prisma.session.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { id: true },
    skip: MAX_SESSIONS - 1,
  });
  if (rows.length) {
    await prisma.session.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
  }
}

export async function createSession(
  userId: string,
  secondFactor: SessionFactor,
  meta: RequestMeta,
): Promise<{ cookie: string; expiresAt: Date }> {
  await pruneSessions(userId);
  const session = newSessionToken();
  await prisma.session.create({
    data: {
      userId,
      tokenHash: session.tokenHash,
      expiresAt: session.expiresAt,
      secondFactor,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    },
  });
  return { cookie: await signSessionToken(session.token), expiresAt: session.expiresAt };
}

export async function currentSessionToken(): Promise<string | null> {
  const raw = (await cookies()).get(SESSION_COOKIE)?.value;
  return raw ? verifySessionCookie(raw) : null;
}

export async function revokeSessionByToken(token: string) {
  await prisma.session.deleteMany({ where: { tokenHash: digest(token) } });
}

export async function revokeSessionCookie(value: string | null | undefined) {
  const token = value ? await verifySessionCookie(value) : null;
  if (token) await revokeSessionByToken(token);
}

export async function setSessionCookie(token: string, expiresAt: Date) {
  const store = await cookies();
  await revokeSessionCookie(store.get(SESSION_COOKIE)?.value);
  const opts = sessionCookieOptions(expiresAt);
  store.set(opts.name, await signSessionToken(token), opts);
}

export async function startSession(
  userId: string,
  secondFactor: SessionFactor,
): Promise<void> {
  const store = await cookies();
  await revokeSessionCookie(store.get(SESSION_COOKIE)?.value);
  const { cookie, expiresAt } = await createSession(userId, secondFactor, await requestMeta());
  const opts = sessionCookieOptions(expiresAt);
  store.set(opts.name, cookie, opts);
}

export const SESSION_FACTORS: readonly SessionFactor[] = ["TOTP", "RECOVERY", "PASSKEY", "SSO"];

export async function getSession(): Promise<SessionResult> {
  const token = await currentSessionToken();
  if (!token) return { error: true, message: "Unauthorized" };
  const row = await prisma.session.findUnique({
    where: { tokenHash: digest(token) },
    include: {
      user: {
        include: { role: { select: { id: true, templateKey: true, name: true, permissions: true } } },
      },
    },
  });
  const now = Date.now();
  const factor = SESSION_FACTORS.find((value) => value === row?.secondFactor);
  if (
    !row ||
    !factor ||
    row.expiresAt.getTime() <= now ||
    now - row.lastActive.getTime() > SESSION_IDLE_TTL_MS ||
    row.user.blocked
  ) {
    return { error: true, message: "Unauthorized" };
  }

  if (now - row.lastActive.getTime() > ACTIVITY_WRITE_INTERVAL_MS) {
    await prisma.session.update({
      where: { id: row.id },
      data: { lastActive: new Date(now) },
    });
  }

  const { role, ...user } = row.user;
  return {
    error: false,
    sessionId: row.id,
    user: { ...user, roleId: user.roleId },
    isOwner: user.isOwner,
    role: role ? { id: role.id, templateKey: role.templateKey, name: role.name } : null,
    permissions: effectivePermissions({
      isOwner: user.isOwner,
      rolePermissions: role?.permissions ?? [],
      orgId: user.orgId,
    }),
    secondFactor: factor,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
  };
}

