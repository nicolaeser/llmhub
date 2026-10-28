import type { ConsoleUser, UsersConsolePayload } from "@/types/users";

export type UserAction =
  | "usage"
  | "logs"
  | "role"
  | "budget"
  | "boost"
  | "password"
  | "content"
  | "sessions"
  | "reset"
  | "emergency"
  | "credentials"
  | "block"
  | "delete";

type ActionFlags = Pick<UsersConsolePayload, "canManage" | "canSecure" | "canBudget" | "insights" | "selfId">;

export function userActions(
  flags: ActionFlags,
  user: Pick<ConsoleUser, "id" | "manageable" | "budget" | "credentialsSuspended">,
): UserAction[] {
  const actions: UserAction[] = [];
  if (flags.insights === "all" || (flags.insights === "own" && user.id === flags.selfId)) actions.push("usage", "logs");
  if (!user.manageable) return actions;
  if (flags.canManage) actions.push("role");
  if (flags.canBudget) actions.push("budget");
  if (flags.canBudget && (user.budget?.maxBudget ?? 0) > 0) actions.push("boost");
  if (flags.canManage) actions.push("password", "content");
  if (flags.canSecure) actions.push("sessions", "reset", "emergency");
  if (flags.canManage && user.credentialsSuspended) actions.push("credentials");
  if (flags.canManage) actions.push("block", "delete");
  return actions;
}

export function hasUserActions(payload: ActionFlags & Pick<UsersConsolePayload, "users">): boolean {
  return payload.users.some((user) => userActions(payload, user).length > 0);
}

export function usersWithAccessTo<T extends Pick<ConsoleUser, "orgId">>(users: T[], company: string): T[] {
  return company ? users.filter((user) => user.orgId === company) : users;
}
