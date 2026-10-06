import type { RoleOption, RoleTemplateKey } from "@/types/auth";

type TenancyOption = { id: string; alias: string };

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
  teamId: string | null;
  orgAlias: string;
  teamAlias: string;
  twoFactorEnabled: boolean;
  passkeys: number;
  activeSessions: number;
  lastActive: string | null;
  mustChangePassword: boolean;
  logContent: boolean;
  revision: number;
  manageable: boolean;
};

export type UsersConsolePayload = {
  users: ConsoleUser[];
  roles: RoleOption[];
  orgs: TenancyOption[];
  teams: (TenancyOption & { orgId: string | null })[];
  selfId: string;
  canManage: boolean;
  canSecure: boolean;
};
