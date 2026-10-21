import type { ConsoleUser, UsersConsolePayload } from "@/types/users";

export type UserAction = "role" | "budget" | "boost" | "password" | "content" | "sessions" | "reset" | "block" | "delete";

type ActionFlags = Pick<UsersConsolePayload, "canManage" | "canSecure" | "canBudget">;

export function userActions(flags: ActionFlags, user: Pick<ConsoleUser, "manageable" | "budget">): UserAction[] {
  if (!user.manageable) return [];
  const actions: UserAction[] = [];
  if (flags.canManage) actions.push("role");
  if (flags.canBudget) actions.push("budget");
  if (flags.canBudget && (user.budget?.maxBudget ?? 0) > 0) actions.push("boost");
  if (flags.canManage) actions.push("password", "content");
  if (flags.canSecure) actions.push("sessions", "reset");
  if (flags.canManage) actions.push("block", "delete");
  return actions;
}

export function hasUserActions(payload: ActionFlags & Pick<UsersConsolePayload, "users">): boolean {
  return payload.users.some((user) => userActions(payload, user).length > 0);
}
