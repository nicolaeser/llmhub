"use server";

import { requirePermission } from "@/lib/auth/guards";
import { PERMISSIONS } from "@/lib/auth/permissions";
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
    await deleteUser(await requirePermission(PERMISSIONS.USERS_MANAGE), id);
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
