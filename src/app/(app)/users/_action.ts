"use server";

import { grantedPermissions, requirePlatformPermission } from "@/lib/auth/guards";
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
import { setBudget } from "@/lib/tenancy/budgets";
import {
  assignUserAccess,
  changeUsers,
  createUser,
  deleteUser,
  loadUsersConsole,
  resetUserTwoFactor,
  revokeUserSessions,
  setUserBlocked,
  setUserContentLogging,
  setUserPassword,
} from "@/lib/auth/users";

export async function loadUserTabsAction() {
  return runAction(() => grantedPermissions([PERMISSIONS.USERS_READ, PERMISSIONS.ROLES_MANAGE]));
}

export async function loadConsoleUsersAction() {
  return runAction(() => loadUsersConsole());
}

export async function createUserAction(input: unknown) {
  return runAction(() =>
    changeUsers(PERMISSIONS.USERS_MANAGE, (session) => createUser(session, input)),
  );
}

export async function setUserBlockedAction(id: string, blocked: boolean) {
  return runAction(() =>
    changeUsers(PERMISSIONS.USERS_MANAGE, (session) => setUserBlocked(session, id, blocked)),
  );
}

export async function setUserContentLoggingAction(id: string, enabled: boolean) {
  return runAction(() =>
    changeUsers(PERMISSIONS.USERS_MANAGE, (session) =>
      setUserContentLogging(session, id, enabled === true),
    ),
  );
}

export async function deleteUserAction(id: string) {
  return runAction(async () => {
    await deleteUser(await requirePlatformPermission(PERMISSIONS.USERS_MANAGE), id);
    return { id };
  });
}

export async function setUserPasswordAction(input: unknown) {
  return runAction(() =>
    changeUsers(PERMISSIONS.USERS_MANAGE, (session) => setUserPassword(session, input)),
  );
}

export async function assignUserAccessAction(input: unknown) {
  return runAction(() =>
    changeUsers(PERMISSIONS.USERS_MANAGE, (session) => assignUserAccess(session, input)),
  );
}

export async function resetUserTwoFactorAction(input: unknown) {
  return runAction(() =>
    changeUsers(PERMISSIONS.USERS_SECURITY, (session) => resetUserTwoFactor(session, input)),
  );
}

export async function revokeUserSessionsAction(id: string) {
  return runAction(() =>
    changeUsers(PERMISSIONS.USERS_SECURITY, (session) => revokeUserSessions(session, id)),
  );
}

export async function setBudgetAction(...args: Parameters<typeof setBudget>) {
  return runAction(() => setBudget(...args));
}

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
    const session = await requirePlatformPermission(PERMISSIONS.ROLES_MANAGE);
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
