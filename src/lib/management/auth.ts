import "server-only";
import prisma from "@/lib/db/prisma";
import { digest, randomToken } from "@/lib/crypto";
import { AuthError, parseAuthInput } from "@/lib/auth/errors";
import { assertCanGrant, grantActor } from "@/lib/auth/grants";
import { effectivePermissions } from "@/lib/auth/permissions";
import { requireStepUp } from "@/lib/auth/second-factor";
import { recordSecurityEvent, userActor } from "@/lib/auth/security-events";
import { requestMeta } from "@/lib/auth/session";
import { writeAudit } from "@/lib/gateway/audit";
import { bearerToken, clientIp } from "@/lib/http/api";
import { ApiProblem } from "@/lib/http/problem";
import {
  isManagementKey,
  keyScope,
  managementPermissions,
  MANAGEMENT_KEY_PREFIX,
  MANAGEMENT_PERMISSIONS,
} from "@/lib/management/scope";
import { createManagementKeySchema } from "@/schemas/management";
import type { AuthenticatedSession } from "@/types/auth";
import type { ManagementKeyRow, ManagementKeysPayload, ManagementKeyView } from "@/types/management";

const MAX_KEYS_PER_USER = 25;
const LAST_USED_WRITE_MS = 60_000;
const CHALLENGE = { "www-authenticate": 'Bearer realm="llmhub-api"' };

export function toManagementKeyView(row: ManagementKeyRow): ManagementKeyView {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    permissions: managementPermissions(row.permissions),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function managementKeysPayload(session: AuthenticatedSession): Promise<ManagementKeysPayload> {
  const rows = await prisma.managementKey.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
  });
  return {
    keys: rows.map(toManagementKeyView),
    grantable: keyScope(MANAGEMENT_PERMISSIONS, session.permissions),
  };
}

export async function createManagementKey(session: AuthenticatedSession, raw: unknown): Promise<string> {
  const input = parseAuthInput(createManagementKeySchema, raw);
  assertCanGrant(grantActor(session), input.permissions);
  await requireStepUp(session.user.id, input.code);
  const userId = session.user.id;
  if ((await prisma.managementKey.count({ where: { userId } })) >= MAX_KEYS_PER_USER) {
    throw new AuthError("KEY_LIMIT");
  }
  const secret = `${MANAGEMENT_KEY_PREFIX}${randomToken()}`;
  const row = await prisma.managementKey.create({
    data: {
      userId,
      name: input.name,
      prefix: secret.slice(0, MANAGEMENT_KEY_PREFIX.length + 8),
      hash: digest(secret),
      permissions: input.permissions,
      expiresAt: input.days ? new Date(Date.now() + input.days * 86_400_000) : null,
    },
  });
  await recordSecurityEvent(userId, userActor(userId), "management_key.created", (await requestMeta()).ipAddress);
  await writeAudit({
    actor: userId,
    action: "management_key.create",
    objectType: "management_key",
    objectId: row.id,
    after: { name: row.name, prefix: row.prefix, permissions: row.permissions, expiresAt: row.expiresAt },
  });
  return secret;
}

export async function revokeManagementKey(session: AuthenticatedSession, id: unknown): Promise<void> {
  const userId = session.user.id;
  const row =
    typeof id === "string" && id ? await prisma.managementKey.findFirst({ where: { id, userId } }) : null;
  if (!row) throw new AuthError("NOT_FOUND");
  await prisma.managementKey.delete({ where: { id: row.id } });
  await recordSecurityEvent(userId, userActor(userId), "management_key.revoked", (await requestMeta()).ipAddress);
  await writeAudit({
    actor: userId,
    action: "management_key.revoke",
    objectType: "management_key",
    objectId: row.id,
    before: { name: row.name, prefix: row.prefix },
  });
}

export async function authenticateManagementKey(req: Request): Promise<AuthenticatedSession> {
  const token = bearerToken(req);
  if (!token) {
    throw new ApiProblem("UNAUTHORIZED", "send Authorization: Bearer with a management key", {
      headers: CHALLENGE,
    });
  }
  if (!isManagementKey(token)) {
    throw new ApiProblem("INVALID_API_KEY", `management keys start with ${MANAGEMENT_KEY_PREFIX}`, {
      headers: CHALLENGE,
    });
  }
  const row = await prisma.managementKey.findUnique({
    where: { hash: digest(token) },
    include: {
      user: {
        include: { role: { select: { id: true, templateKey: true, name: true, permissions: true } } },
      },
    },
  });
  const now = Date.now();
  if (!row || (row.expiresAt && row.expiresAt.getTime() <= now) || row.user.blocked) {
    throw new ApiProblem("INVALID_API_KEY", "the management key is invalid, expired, or revoked", {
      headers: CHALLENGE,
    });
  }
  if (!row.lastUsedAt || now - row.lastUsedAt.getTime() > LAST_USED_WRITE_MS) {
    await prisma.managementKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date(now) } });
  }
  const { role, ...user } = row.user;
  const current = effectivePermissions({
    isOwner: user.isOwner,
    rolePermissions: role?.permissions ?? [],
    orgId: user.orgId,
  });
  return {
    error: false,
    sessionId: "",
    user,
    isOwner: false,
    role: role ? { id: role.id, templateKey: role.templateKey, name: role.name } : null,
    permissions: keyScope(row.permissions, current),
    secondFactor: "MANAGEMENT_KEY",
    ipAddress: clientIp(req.headers) || null,
    userAgent: req.headers.get("user-agent")?.slice(0, 512) ?? null,
  };
}
