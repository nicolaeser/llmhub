import "server-only";
import prisma from "@/lib/db/prisma";
import { digest } from "@/lib/crypto";
import { toKeyView } from "@/app/(app)/_data";
import { effectivePermissions, hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { isTryBearer, verifyTryBearer } from "@/lib/gateway/try-bearer";
import { modelAccess, templateRuleSelect } from "@/lib/gateway/model-access";
import { templateRulesOf } from "@/lib/gateway/model-policy";
import { GateError } from "@/lib/gateway/errors";
import { isManagementKey } from "@/lib/management/scope";
import { resolveKeyTenancy } from "@/lib/gateway/key-tenancy";
import type { VirtualKeyView, Principal } from "@/types/gateway";

export function sessionPrincipal(user: { id: string; orgId: string | null }): Principal {
  return {
    actor: user.id,
    teamId: "",
    orgId: user.orgId ?? "",
    userId: user.id,
    memberId: "",
    models: [],
    routeLimits: {},
  };
}

const keyInclude = {
  templates: { select: { templateId: true, template: { select: templateRuleSelect } } },
} as const;

async function principalFromKey(
  row: Omit<Parameters<typeof toKeyView>[0], "templates"> & {
    templates: { templateId: string; template: Parameters<typeof templateRulesOf>[0] }[];
  },
): Promise<Principal | null> {
  const { tenancy, active } = await resolveKeyTenancy(row);
  if (!active) return null;
  const key: VirtualKeyView = toKeyView(row);
  const access = await modelAccess(
    key.models,
    row.templates.map((link) => templateRulesOf(link.template)),
  );
  return {
    actor: row.prefix,
    key,
    teamId: tenancy.teamId,
    orgId: tenancy.orgId,
    userId: tenancy.userId,
    memberId: tenancy.memberId,
    models: access.models,
    routeLimits: access.limits,
  };
}

export async function keyPrincipal(keyId: string): Promise<Principal | null> {
  const row = await prisma.virtualKey.findUnique({
    where: { id: keyId },
    include: keyInclude,
  });
  if (!row || row.blocked || (row.expiresAt && row.expiresAt < new Date())) return null;
  return principalFromKey(row);
}

export async function authenticateBearer(token: string): Promise<Principal> {
  if (!token) throw new GateError(401, "invalid_api_key", "missing bearer token");
  if (isManagementKey(token)) {
    throw new GateError(401, "invalid_api_key", "management keys only work on /api");
  }

  if (isTryBearer(token)) {
    const parsed = verifyTryBearer(token);
    if (!parsed) throw new GateError(401, "invalid_api_key", "invalid api key");
    const user = await prisma.user.findUnique({
      where: { id: parsed.userId },
      include: { role: { select: { permissions: true } } },
    });
    if (!user || user.blocked) {
      throw new GateError(401, "invalid_api_key", "invalid api key");
    }
    const permissions = effectivePermissions({
      isOwner: user.isOwner,
      rolePermissions: user.role?.permissions ?? [],
      orgId: user.orgId,
    });
    if (!hasPerm(permissions, PERMISSIONS.PLAYGROUND_USE)) {
      throw new GateError(403, "permission_denied", "playground access is not allowed for this user");
    }
    return sessionPrincipal(user);
  }

  const hash = digest(token);
  const row = await prisma.virtualKey.findFirst({
    where: {
      OR: [
        { hash },
        { prevHash: hash, prevHashUntil: { gt: new Date() } },
      ],
    },
    include: keyInclude,
  });
  if (row && !row.blocked && (!row.expiresAt || row.expiresAt >= new Date())) {
    const principal = await principalFromKey(row);
    if (principal) return principal;
    throw new GateError(401, "invalid_api_key", "api key owner is not active");
  }

  throw new GateError(401, "invalid_api_key", "invalid api key");
}
