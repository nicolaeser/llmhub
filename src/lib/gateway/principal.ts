import "server-only";
import prisma from "@/lib/db/prisma";
import { digest } from "@/lib/crypto";
import { toKeyView } from "@/app/(app)/_data";
import { effectivePermissions, hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { isTryBearer, verifyTryBearer } from "@/lib/gateway/try-bearer";
import { allowedModels, templateRuleSelect } from "@/lib/gateway/model-access";
import { templateRulesOf } from "@/lib/gateway/model-policy";
import { GateError } from "@/lib/gateway/errors";
import { isManagementKey } from "@/lib/management/scope";
import type { VirtualKeyView, Principal } from "@/types/gateway";

const OWNER_SELECT = { id: true, blocked: true, teamId: true, orgId: true } as const;

async function liveScope(input: {
  projectId: string | null;
  teamId: string | null;
  member: { teamId: string | null; orgId: string | null } | null;
}): Promise<{ teamId: string; orgId: string }> {
  const project = input.projectId
    ? await prisma.project.findUnique({ where: { id: input.projectId }, select: { teamId: true } })
    : null;
  const bound = project?.teamId ?? input.teamId;
  const teamId = bound ?? input.member?.teamId ?? null;
  const team = teamId
    ? await prisma.team.findUnique({ where: { id: teamId }, select: { id: true, orgId: true } })
    : null;
  if (!team) return { teamId: "", orgId: input.member?.orgId ?? "" };
  return { teamId: team.id, orgId: team.orgId ?? (bound ? "" : (input.member?.orgId ?? "")) };
}

export async function sessionPrincipal(user: {
  id: string;
  teamId?: string | null;
  orgId?: string | null;
}): Promise<Principal> {
  const scope = await liveScope({
    projectId: null,
    teamId: null,
    member: { teamId: user.teamId ?? null, orgId: user.orgId ?? null },
  });
  return { actor: user.id, ...scope, userId: user.id, models: [] };
}

const keyInclude = {
  user: { select: OWNER_SELECT },
  templates: { select: { templateId: true, template: { select: templateRuleSelect } } },
} as const;

async function principalFromKey(
  row: Omit<Parameters<typeof toKeyView>[0], "templates"> & {
    user: { id: string; blocked: boolean; teamId: string | null; orgId: string | null } | null;
    templates: { templateId: string; template: Parameters<typeof templateRulesOf>[0] }[];
  },
): Promise<Principal | null> {
  if (!row.user || row.user.blocked) return null;
  const key: VirtualKeyView = toKeyView(row);
  const scope = await liveScope({
    projectId: row.projectId,
    teamId: row.teamId,
    member: row.user,
  });
  return {
    actor: row.prefix,
    key,
    ...scope,
    userId: row.user.id,
    models: await allowedModels(
      key.models,
      row.templates.map((link) => templateRulesOf(link.template)),
    ),
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
