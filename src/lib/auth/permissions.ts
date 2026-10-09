import type { Permission, PermissionDomain, PermissionLevel, PermissionMeta, RoleTemplateKey } from "@/types/auth";

const permissionDomains = [
  "keys",
  "providers",
  "models",
  "tenancy",
  "spend",
  "access",
  "settings",
  "tools",
] as const satisfies readonly PermissionDomain[];
const meta = (domain: PermissionDomain, level: PermissionLevel): PermissionMeta => ({
  domain,
  level,
});

export const permissionCatalog = {
  "keys:read": meta("keys", "view"),
  "keys:read-all": meta("keys", "view"),
  "keys:manage": meta("keys", "work"),
  "providers:read": meta("providers", "view"),
  "providers:manage": meta("providers", "sensitive"),
  "models:read": meta("models", "view"),
  "models:manage": meta("models", "work"),
  "tenancy:read": meta("tenancy", "view"),
  "tenancy:manage": meta("tenancy", "work"),
  "spend:read": meta("spend", "view"),
  "spend:read-all": meta("spend", "view"),
  "logs:content": meta("spend", "sensitive"),
  "budgets:manage": meta("spend", "work"),
  "pricing:read": meta("spend", "view"),
  "pricing:manage": meta("spend", "work"),
  "users:read": meta("access", "view"),
  "users:manage": meta("access", "sensitive"),
  "users:security": meta("access", "sensitive"),
  "roles:manage": meta("access", "sensitive"),
  "settings:read": meta("settings", "view"),
  "settings:manage": meta("settings", "sensitive"),
  "playground:use": meta("tools", "work"),
  "assistant:use": meta("tools", "work"),
} as const satisfies Record<Permission, PermissionMeta>;

export const permissions = Object.keys(permissionCatalog) as Permission[];

export const PERMISSIONS = {
  KEYS_READ: "keys:read",
  KEYS_READ_ALL: "keys:read-all",
  KEYS_MANAGE: "keys:manage",
  PROVIDERS_READ: "providers:read",
  PROVIDERS_MANAGE: "providers:manage",
  MODELS_READ: "models:read",
  MODELS_MANAGE: "models:manage",
  TENANCY_READ: "tenancy:read",
  TENANCY_MANAGE: "tenancy:manage",
  SPEND_READ: "spend:read",
  SPEND_READ_ALL: "spend:read-all",
  LOGS_CONTENT: "logs:content",
  BUDGETS_MANAGE: "budgets:manage",
  PRICING_READ: "pricing:read",
  PRICING_MANAGE: "pricing:manage",
  USERS_READ: "users:read",
  USERS_MANAGE: "users:manage",
  USERS_SECURITY: "users:security",
  ROLES_MANAGE: "roles:manage",
  SETTINGS_READ: "settings:read",
  SETTINGS_MANAGE: "settings:manage",
  PLAYGROUND_USE: "playground:use",
  ASSISTANT_USE: "assistant:use",
} as const satisfies Record<string, Permission>;

export const roleTemplateKeys = ["admin", "operator", "finance", "viewer"] as const satisfies readonly RoleTemplateKey[];

const template = (list: readonly Permission[]): readonly Permission[] =>
  permissions.filter((permission) => list.includes(permission));

export const roleTemplates: Readonly<Record<RoleTemplateKey, readonly Permission[]>> = {
  admin: template(permissions),
  operator: template(
    permissions.filter(
      (permission) =>
        permission !== "roles:manage" &&
        permission !== "settings:manage" &&
        permission !== "users:security" &&
        permission !== "logs:content",
    ),
  ),
  finance: template([
    "keys:read",
    "providers:read",
    "models:read",
    "tenancy:read",
    "users:read",
    "spend:read",
    "spend:read-all",
    "pricing:read",
    "pricing:manage",
    "settings:read",
  ]),
  viewer: template([
    "keys:read",
    "providers:read",
    "models:read",
    "tenancy:read",
    "users:read",
    "spend:read",
    "settings:read",
    "playground:use",
    "assistant:use",
  ]),
};

export const COMPANY_PERMISSIONS = [
  "keys:read",
  "keys:read-all",
  "keys:manage",
  "tenancy:read",
  "tenancy:manage",
  "spend:read",
  "spend:read-all",
  "logs:content",
  "budgets:manage",
  "playground:use",
] as const satisfies readonly Permission[];

export function isRoleTemplateKey(value: unknown): value is RoleTemplateKey {
  return roleTemplateKeys.includes(value as RoleTemplateKey);
}

function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && Object.hasOwn(permissionCatalog, value);
}

export function permissionList(value: unknown): Permission[] {
  if (!Array.isArray(value)) return [];
  return sortPermissions(value.filter(isPermission));
}

export function sortPermissions(list: readonly Permission[]): Permission[] {
  const set = new Set(list);
  return permissions.filter((permission) => set.has(permission));
}

export function effectivePermissions(input: {
  isOwner: boolean;
  rolePermissions: unknown;
  orgId: string | null;
}): Permission[] {
  if (input.isOwner) return [...permissions];
  const granted = permissionList(input.rolePermissions);
  if (!input.orgId) return granted;
  const allowed = new Set<Permission>(COMPANY_PERMISSIONS);
  return granted.filter((permission) => allowed.has(permission));
}

export function isSubset(
  subset: readonly Permission[],
  superset: readonly Permission[],
): boolean {
  const set = new Set(superset);
  return subset.every((permission) => set.has(permission));
}

export function hasPerm(perms: readonly Permission[], name: Permission): boolean {
  return perms.includes(name);
}

export function permissionsByDomain(list: readonly Permission[] = permissions) {
  return permissionDomains
    .map((domain) => ({
      domain,
      permissions: list.filter((permission) => permissionCatalog[permission].domain === domain),
    }))
    .filter((group) => group.permissions.length > 0);
}
