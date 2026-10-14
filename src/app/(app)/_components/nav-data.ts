import {
  Activity,
  BarChart3,
  Blocks,
  Building2,
  Code2,
  KeyRound,
  Library,
  Network,
  Plug,
  Settings,
  Shield,
  User,
} from "lucide-react";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import type { Permission } from "@/types/auth";
import type { NavSection } from "@/types/console";

export const NAV: NavSection[] = [
  {
    id: "organization",
    labelKey: "sections.organization",
    items: [
      { href: "/companies", labelKey: "items.companies", icon: Building2, permission: PERMISSIONS.TENANCY_READ },
      {
        href: "/keys",
        labelKey: "items.keys",
        icon: KeyRound,
        permission: [PERMISSIONS.KEYS_READ, PERMISSIONS.MODELS_READ],
      },
      {
        href: "/users",
        labelKey: "items.users",
        icon: User,
        permission: [PERMISSIONS.USERS_READ, PERMISSIONS.ROLES_MANAGE],
      },
    ],
  },
  {
    id: "models",
    labelKey: "sections.models",
    items: [
      { href: "/providers", labelKey: "items.providers", icon: Plug, permission: PERMISSIONS.PROVIDERS_READ },
      { href: "/models", labelKey: "items.models", icon: Network, permission: PERMISSIONS.MODELS_READ },
    ],
  },
  {
    id: "policies",
    labelKey: "sections.policies",
    items: [
      { href: "/guardrails", labelKey: "items.guardrails", icon: Shield, permission: PERMISSIONS.SETTINGS_READ },
      { href: "/knowledge", labelKey: "items.knowledge", icon: Library, permission: PERMISSIONS.TENANCY_READ },
      { href: "/mcp", labelKey: "items.mcp", icon: Blocks, permission: PERMISSIONS.SETTINGS_READ },
    ],
  },
  {
    id: "insights",
    labelKey: "sections.insights",
    items: [
      {
        href: "/usage",
        labelKey: "items.usage",
        icon: BarChart3,
        permission: [PERMISSIONS.SPEND_READ, PERMISSIONS.PRICING_READ],
      },
      { href: "/logs", labelKey: "items.logs", icon: Activity, permission: PERMISSIONS.SPEND_READ },
    ],
  },
  {
    id: "system",
    labelKey: "sections.system",
    items: [
      { href: "/settings", labelKey: "items.settings", icon: Settings, permission: PERMISSIONS.SETTINGS_READ },
      {
        href: "/developer",
        labelKey: "items.developer",
        icon: Code2,
        permission: [PERMISSIONS.PLAYGROUND_USE, PERMISSIONS.KEYS_READ],
      },
    ],
  },
];

const NO_NAV_HOME = "/account";

export function canSee(permissions: readonly Permission[], item: { permission: Permission | readonly Permission[] }) {
  const needed: readonly Permission[] = Array.isArray(item.permission) ? item.permission : [item.permission];
  return needed.some((permission) => hasPerm(permissions, permission));
}

export function homePath(permissions: readonly Permission[]): string {
  const first = NAV.flatMap((section) => section.items).find((item) => canSee(permissions, item));
  return first?.href ?? NO_NAV_HOME;
}
