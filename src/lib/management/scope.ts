import { permissionList } from "@/lib/auth/permissions";
import type { Permission } from "@/types/auth";

export const MANAGEMENT_KEY_PREFIX = "sk-mgmt-";

export const MANAGEMENT_PERMISSIONS = [
  "keys:read",
  "keys:read-all",
  "keys:manage",
  "providers:read",
  "providers:manage",
  "models:read",
  "models:manage",
  "tenancy:read",
  "tenancy:manage",
  "spend:read",
  "spend:read-all",
  "budgets:manage",
  "pricing:read",
  "pricing:manage",
] as const satisfies readonly Permission[];

const ALLOWED = new Set<Permission>(MANAGEMENT_PERMISSIONS);

export function isManagementKey(token: string): boolean {
  return token.startsWith(MANAGEMENT_KEY_PREFIX);
}

export function managementPermissions(list: unknown): Permission[] {
  return permissionList(list).filter((permission) => ALLOWED.has(permission));
}

export function keyScope(granted: unknown, current: readonly Permission[]): Permission[] {
  const held = new Set(current);
  return managementPermissions(granted).filter((permission) => held.has(permission));
}
