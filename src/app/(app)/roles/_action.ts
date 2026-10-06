"use server";

import prisma from "@/lib/db/prisma";
import { requirePermission } from "@/lib/auth/guards";
import { AuthError } from "@/lib/auth/errors";
import { grantActor } from "@/lib/auth/grants";
import { permissions, PERMISSIONS, roleTemplateKeys } from "@/lib/auth/permissions";
import {
  createRole,
  deleteRole,
  listRoles,
  resetRoleToTemplate,
  restoreRoleTemplate,
  updateRole,
} from "@/lib/auth/roles";
import { runAction } from "@/lib/http/action-result";
import type { AuthenticatedSession, RoleSummary, RolesConsolePayload } from "@/types/auth";

async function payload(session: AuthenticatedSession): Promise<RolesConsolePayload> {
  const actor = grantActor(session);
  const [roles, templates] = await Promise.all([
    listRoles(actor),
    prisma.role.findMany({ where: { templateKey: { not: null } }, select: { templateKey: true } }),
  ]);
  const present = new Set(templates.map((row) => row.templateKey));
  return {
    roles,
    grantable: actor.isOwner ? [...permissions] : [...actor.permissions],
    missingTemplates: roleTemplateKeys.filter((key) => !present.has(key)),
  };
}

async function mutate(
  mutation: (session: AuthenticatedSession) => Promise<{ id: string }>,
): Promise<{ role: RoleSummary }> {
  const session = await requirePermission(PERMISSIONS.ROLES_MANAGE);
  const { id } = await mutation(session);
  const role = (await listRoles(grantActor(session))).find((row) => row.id === id);
  if (!role) throw new AuthError("ROLE_NOT_FOUND");
  return { role };
}

export async function loadRolesAction() {
  return runAction(async () => payload(await requirePermission(PERMISSIONS.ROLES_MANAGE)));
}

export async function createRoleAction(input: unknown) {
  return runAction(() => mutate((session) => createRole(grantActor(session), session.user.id, input)));
}

export async function updateRoleAction(roleId: string, input: unknown) {
  return runAction(() =>
    mutate((session) => updateRole(grantActor(session), session.user.id, roleId, input)),
  );
}

export async function deleteRoleAction(roleId: string) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.ROLES_MANAGE);
    await deleteRole(grantActor(session), session.user.id, roleId);
    return { id: roleId };
  });
}

export async function resetRoleAction(roleId: string, revision: number) {
  return runAction(() =>
    mutate((session) => resetRoleToTemplate(grantActor(session), session.user.id, roleId, revision)),
  );
}

export async function restoreTemplateAction(key: string) {
  return runAction(() =>
    mutate((session) => restoreRoleTemplate(grantActor(session), session.user.id, key)),
  );
}
