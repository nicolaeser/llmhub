"use server";

import { requirePermission } from "@/lib/auth/guards";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { runAction } from "@/lib/http/action-result";
import {
  assignUserRole,
  createUser,
  deleteUser,
  resetUserTwoFactor,
  revokeUserSessions,
  setUserBlocked,
  setUserContentLogging,
  setUserPassword,
  usersConsole,
} from "@/lib/auth/users";
import type { AuthenticatedSession, Permission } from "@/types/auth";

async function mutateThenList(
  permission: Permission,
  mutation: (session: AuthenticatedSession) => Promise<unknown>,
) {
  const session = await requirePermission(permission);
  await mutation(session);
  return usersConsole(session);
}

export async function loadConsoleUsersAction() {
  return runAction(async () => usersConsole(await requirePermission(PERMISSIONS.USERS_READ)));
}

export async function createUserAction(input: unknown) {
  return runAction(() =>
    mutateThenList(PERMISSIONS.USERS_MANAGE, (session) => createUser(session, input)),
  );
}

export async function setUserBlockedAction(id: string, blocked: boolean) {
  return runAction(() =>
    mutateThenList(PERMISSIONS.USERS_MANAGE, (session) => setUserBlocked(session, id, blocked)),
  );
}

export async function setUserContentLoggingAction(id: string, enabled: boolean) {
  return runAction(() =>
    mutateThenList(PERMISSIONS.USERS_MANAGE, (session) =>
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
    mutateThenList(PERMISSIONS.USERS_MANAGE, (session) => setUserPassword(session, input)),
  );
}

export async function assignUserRoleAction(input: unknown) {
  return runAction(() =>
    mutateThenList(PERMISSIONS.USERS_MANAGE, (session) => assignUserRole(session, input)),
  );
}

export async function resetUserTwoFactorAction(input: unknown) {
  return runAction(() =>
    mutateThenList(PERMISSIONS.USERS_SECURITY, (session) => resetUserTwoFactor(session, input)),
  );
}

export async function revokeUserSessionsAction(id: string) {
  return runAction(() =>
    mutateThenList(PERMISSIONS.USERS_SECURITY, (session) => revokeUserSessions(session, id)),
  );
}
