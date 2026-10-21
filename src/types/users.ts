import type { RoleOption, RoleTemplateKey } from "@/types/auth";

type TenancyOption = { id: string; alias: string };

export type ConsoleUserBudget = { maxBudget: number; spend: number; budgetDuration: string };

export type ConsoleUser = {
  id: string;
  username: string;
  email: string;
  roleId: string | null;
  roleName: string | null;
  roleTemplateKey: RoleTemplateKey | null;
  isOwner: boolean;
  blocked: boolean;
  orgId: string | null;
  orgAlias: string;
  budget: ConsoleUserBudget | null;
  twoFactorEnabled: boolean;
  passkeys: number;
  activeSessions: number;
  lastActive: string | null;
  mustChangePassword: boolean;
  logContent: boolean;
  revision: number;
  manageable: boolean;
};

export type InsightReach = "all" | "own" | "none";

export type UsersConsolePayload = {
  users: ConsoleUser[];
  roles: RoleOption[];
  orgs: TenancyOption[];
  selfId: string;
  canManage: boolean;
  canSecure: boolean;
  canBudget: boolean;
  canSeeCompanies: boolean;
  insights: InsightReach;
};
