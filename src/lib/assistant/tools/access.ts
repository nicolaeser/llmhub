import "server-only";

import prisma from "@/lib/db/prisma";
import {
  assignUserRoleAction,
  loadConsoleUsersAction,
  revokeUserSessionsAction,
  setUserBlockedAction,
} from "@/app/(app)/users/_action";
import { loadRolesAction } from "@/app/(app)/roles/_action";
import {
  assignRoleToolInput,
  confirmUserToolInput,
  emptyToolInput,
  listUsersToolInput,
  userBlockedToolInput,
} from "@/schemas/assistant";
import { defineTool, needsConfirmation, toolFail, viaAction } from "@/lib/assistant/tools/define";
import type { ConsoleUser } from "@/types/users";

function userView(user: ConsoleUser) {
  return {
    id: user.id,
    username: user.username,
    roleId: user.roleId,
    role: user.roleName ?? user.roleTemplateKey,
    owner: user.isOwner,
    blocked: user.blocked,
    organization: user.orgAlias,
    team: user.teamAlias,
    twoFactorEnabled: user.twoFactorEnabled,
    passkeys: user.passkeys,
    activeSessions: user.activeSessions,
    lastActive: user.lastActive,
    manageable: user.manageable,
  };
}

function updatedUser(userId: string) {
  return ({ users }: { users: ConsoleUser[] }) => {
    const user = users.find((row) => row.id === userId);
    return { result: { ok: true, user: user ? userView(user) : null }, navigate: "/users" };
  };
}

export const accessTools = {
  list_users: defineTool({
    description:
      "Console users with role, team, organization, blocked state, second-factor status, active sessions, and last activity. No email addresses or secrets.",
    input: listUsersToolInput,
    run: async ({ search }) =>
      viaAction(loadConsoleUsersAction(), ({ users, roles }) => {
        const needle = search?.toLowerCase() ?? "";
        return {
          result: {
            users: users
              .filter((user) => !needle || user.username.toLowerCase().includes(needle))
              .map(userView),
            roles: roles.map((role) => ({
              id: role.id,
              name: role.name ?? role.templateKey,
              assignable: role.assignable,
            })),
          },
        };
      }),
  }),
  list_roles: defineTool({
    description: "Roles with their permissions, member counts, and the assistant tools each role has switched off.",
    input: emptyToolInput,
    run: async () =>
      viaAction(loadRolesAction(), ({ roles }) => ({
        result: roles.map((role) => ({
          id: role.id,
          name: role.name ?? role.templateKey,
          templateKey: role.templateKey,
          description: role.description,
          permissions: role.permissions,
          members: role.memberCount,
          assistantToolsDisabled: role.assistantToolsDisabled,
          editable: role.editable,
        })),
      })),
  }),
  set_user_blocked: defineTool({
    description:
      "Block or unblock a user. Blocking signs them out everywhere. Blocking is destructive: ask first and pass confirm only after the operator agreed.",
    input: userBlockedToolInput,
    run: async ({ userId, blocked, confirm }) =>
      needsConfirmation(confirm || !blocked) ??
      viaAction(setUserBlockedAction(userId, blocked), updatedUser(userId)),
  }),
  assign_user_role: defineTool({
    description: "Give a user another role. Only roles marked assignable in list_users can be given.",
    input: assignRoleToolInput,
    run: async ({ userId, roleId }) => {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { revision: true } });
      if (!user) return toolFail("user_not_found");
      return viaAction(
        assignUserRoleAction({ userId, roleId, revision: user.revision }),
        updatedUser(userId),
      );
    },
  }),
  revoke_user_sessions: defineTool({
    description:
      "Sign a user out of every session. Destructive: ask first and pass confirm only after the operator agreed.",
    input: confirmUserToolInput,
    run: async ({ userId, confirm }) =>
      needsConfirmation(confirm) ??
      viaAction(revokeUserSessionsAction(userId), updatedUser(userId)),
  }),
};
