"use server";

import { requirePermission } from "@/lib/auth/guards";
import { grantActor } from "@/lib/auth/grants";
import { PERMISSIONS } from "@/lib/auth/permissions";
import {
  changeRole,
  createRole,
  deleteRole,
  loadRolesConsole,
  resetRoleToTemplate,
  restoreRoleTemplate,
  updateRole,
} from "@/lib/auth/roles";
import { runAction } from "@/lib/http/action-result";

export async function loadRolesAction() {
  return runAction(() => loadRolesConsole());
}

export async function createRoleAction(input: unknown) {
  return runAction(() => changeRole((session) => createRole(grantActor(session), session.user.id, input)));
}

export async function updateRoleAction(roleId: string, input: unknown) {
  return runAction(() =>
    changeRole((session) => updateRole(grantActor(session), session.user.id, roleId, input)),
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
    changeRole((session) => resetRoleToTemplate(grantActor(session), session.user.id, roleId, revision)),
  );
}

export async function restoreTemplateAction(key: string) {
  return runAction(() =>
    changeRole((session) => restoreRoleTemplate(grantActor(session), session.user.id, key)),
  );
}
