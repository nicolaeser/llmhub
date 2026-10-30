import {
  Activity,
  BarChart3,
  Blocks,
  Building2,
  Code2,
  KeyRound,
  LayoutDashboard,
  Library,
  Network,
  Plug,
  Settings,
  Shield,
  User,
} from "lucide-react";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import type { Permission } from "@/types/auth";
import type { NavItem, NavSection, ScopeKind } from "@/types/console";

const OVERVIEW_PERMISSIONS = {
  platform: [
    PERMISSIONS.TENANCY_READ,
    PERMISSIONS.KEYS_READ,
    PERMISSIONS.PROVIDERS_READ,
    PERMISSIONS.MODELS_READ,
    PERMISSIONS.SPEND_READ,
  ],
  company: [PERMISSIONS.TENANCY_READ, PERMISSIONS.KEYS_READ, PERMISSIONS.SPEND_READ],
} as const satisfies Record<ScopeKind, readonly Permission[]>;

export const NAV: NavSection[] = [
  {
    id: "home",
    labelKey: "sections.home",
    untitled: true,
    items: [
      {
        href: "/overview",
        labelKey: "items.overview",
        scope: "platform",
        icon: LayoutDashboard,
        permission: OVERVIEW_PERMISSIONS.platform,
      },
      {
        href: "/overview",
        labelKey: "items.overview",
        scope: "company",
        icon: LayoutDashboard,
        permission: OVERVIEW_PERMISSIONS.company,
      },
    ],
  },
  {
    id: "organization",
    labelKey: "sections.organization",
    items: [
      { href: "/companies", labelKey: "items.companies", scope: "platform", icon: Building2, permission: PERMISSIONS.TENANCY_READ },
      { href: "/companies", labelKey: "items.company", scope: "company", icon: Building2, permission: PERMISSIONS.TENANCY_READ },
      { href: "/keys", labelKey: "items.keys", scope: "both", icon: KeyRound, permission: PERMISSIONS.KEYS_READ },
      {
        href: "/users",
        labelKey: "items.users",
        scope: "platform",
        icon: User,
        permission: [PERMISSIONS.USERS_READ, PERMISSIONS.ROLES_MANAGE],
      },
    ],
  },
  {
    id: "gateway",
    labelKey: "sections.gateway",
    items: [
      { href: "/providers", labelKey: "items.providers", scope: "platform", icon: Plug, permission: PERMISSIONS.PROVIDERS_READ },
      { href: "/models", labelKey: "items.models", scope: "platform", icon: Network, permission: PERMISSIONS.MODELS_READ },
    ],
  },
  {
    id: "policies",
    labelKey: "sections.policies",
    items: [
      { href: "/guardrails", labelKey: "items.guardrails", scope: "both", icon: Shield, permission: PERMISSIONS.SETTINGS_READ },
      { href: "/knowledge", labelKey: "items.knowledge", scope: "both", icon: Library, permission: PERMISSIONS.TENANCY_READ },
      {
        href: "/mcp",
        labelKey: "items.mcp",
        scope: "both",
        icon: Blocks,
        permission: [PERMISSIONS.SETTINGS_READ, PERMISSIONS.MCP_READ],
      },
    ],
  },
  {
    id: "insights",
    labelKey: "sections.insights",
    items: [
      {
        href: "/usage",
        labelKey: "items.usage",
        scope: "both",
        icon: BarChart3,
        permission: [PERMISSIONS.SPEND_READ, PERMISSIONS.PRICING_READ],
      },
      { href: "/logs", labelKey: "items.logs", scope: "both", icon: Activity, permission: PERMISSIONS.SPEND_READ },
    ],
  },
  {
    id: "system",
    labelKey: "sections.system",
    pinned: true,
    items: [
      { href: "/settings", labelKey: "items.settings", scope: "platform", icon: Settings, permission: PERMISSIONS.SETTINGS_READ },
      {
        href: "/developer",
        labelKey: "items.developer",
        scope: "both",
        icon: Code2,
        permission: [PERMISSIONS.PLAYGROUND_USE, PERMISSIONS.KEYS_READ],
      },
    ],
  },
];

const NO_NAV_HOME = "/account";

function inScope(item: Pick<NavItem, "scope">, scope: ScopeKind): boolean {
  return item.scope === "both" || item.scope === scope;
}

function matchesPath(item: Pick<NavItem, "href">, pathname: string): boolean {
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function canSee(
  permissions: readonly Permission[],
  item: Pick<NavItem, "permission" | "scope">,
  scope: ScopeKind = "platform",
) {
  if (!inScope(item, scope)) return false;
  const needed: readonly Permission[] = Array.isArray(item.permission) ? item.permission : [item.permission];
  return needed.some((permission) => hasPerm(permissions, permission));
}

export function visibleNav(permissions: readonly Permission[], scope: ScopeKind): NavSection[] {
  return NAV.map((section) => ({
    ...section,
    items: section.items.filter((item) => canSee(permissions, item, scope)),
  })).filter((section) => section.items.length > 0);
}

export function canOpen(permissions: readonly Permission[], pathname: string, scope: ScopeKind): boolean {
  return NAV.some((section) =>
    section.items.some((item) => matchesPath(item, pathname) && canSee(permissions, item, scope)),
  );
}

export function homePath(permissions: readonly Permission[], scope: ScopeKind = "platform"): string {
  const first = visibleNav(permissions, scope).flatMap((section) => section.items)[0];
  return first?.href ?? NO_NAV_HOME;
}

export function navItemFor(pathname: string, scope: ScopeKind): NavItem | undefined {
  return NAV.flatMap((section) => section.items).find((item) => inScope(item, scope) && matchesPath(item, pathname));
}

export function platformOnlyPath(pathname: string): boolean {
  const matching = NAV.flatMap((section) => section.items).filter((item) => matchesPath(item, pathname));
  return matching.length > 0 && matching.every((item) => item.scope === "platform");
}
