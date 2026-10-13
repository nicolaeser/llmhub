import {
  Activity,
  BadgePercent,
  BarChart3,
  Bell,
  BookOpen,
  Building2,
  Calculator,
  Code2,
  Database,
  Gauge,
  HeartPulse,
  KeyRound,
  Library,
  ListChecks,
  Network,
  PlayCircle,
  Plug,
  Settings,
  Shield,
  Sparkles,
  User,
  UserCog,
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
      { href: "/keys", labelKey: "items.keys", icon: KeyRound, permission: PERMISSIONS.KEYS_READ },
      { href: "/users", labelKey: "items.users", icon: User, permission: PERMISSIONS.USERS_READ },
      { href: "/roles", labelKey: "items.roles", icon: UserCog, permission: PERMISSIONS.ROLES_MANAGE },
    ],
  },
  {
    id: "models",
    labelKey: "sections.models",
    items: [
      { href: "/providers", labelKey: "items.providers", icon: Plug, permission: PERMISSIONS.PROVIDERS_READ },
      { href: "/subscriptions", labelKey: "items.subscriptions", icon: Gauge, permission: PERMISSIONS.PROVIDERS_READ },
      { href: "/provider-health", labelKey: "items.providerHealth", icon: HeartPulse, permission: PERMISSIONS.PROVIDERS_READ },
      { href: "/model-catalog", labelKey: "items.modelCatalog", icon: BookOpen, permission: PERMISSIONS.MODELS_READ },
      { href: "/models", labelKey: "items.models", icon: Network, permission: PERMISSIONS.MODELS_READ },
      { href: "/model-templates", labelKey: "items.modelTemplates", icon: ListChecks, permission: PERMISSIONS.MODELS_READ },
      { href: "/markups", labelKey: "items.markups", icon: BadgePercent, permission: PERMISSIONS.PRICING_READ },
    ],
  },
  {
    id: "policies",
    labelKey: "sections.policies",
    items: [
      { href: "/guardrails", labelKey: "items.guardrails", icon: Shield, permission: PERMISSIONS.SETTINGS_READ },
      { href: "/cache", labelKey: "items.cache", icon: Database, permission: PERMISSIONS.SETTINGS_READ },
      { href: "/knowledge", labelKey: "items.knowledge", icon: Library, permission: PERMISSIONS.TENANCY_READ },
    ],
  },
  {
    id: "insights",
    labelKey: "sections.insights",
    items: [
      { href: "/usage", labelKey: "items.usage", icon: BarChart3, permission: PERMISSIONS.SPEND_READ },
      { href: "/what-if", labelKey: "items.whatIf", icon: Calculator, permission: PERMISSIONS.SPEND_READ },
      { href: "/logs", labelKey: "items.logs", icon: Activity, permission: PERMISSIONS.SPEND_READ },
    ],
  },
  {
    id: "settings",
    labelKey: "sections.settings",
    items: [
      { href: "/logging", labelKey: "items.logging", icon: Bell, permission: PERMISSIONS.SETTINGS_READ },
      { href: "/admin-settings", labelKey: "items.adminSettings", icon: Settings, permission: PERMISSIONS.SETTINGS_READ },
    ],
  },
  {
    id: "tools",
    labelKey: "sections.tools",
    items: [
      { href: "/playground", labelKey: "items.playground", icon: PlayCircle, permission: PERMISSIONS.PLAYGROUND_USE },
      { href: "/assistant", labelKey: "items.assistant", icon: Sparkles, permission: PERMISSIONS.ASSISTANT_USE },
      { href: "/api-ref", labelKey: "items.apiRef", icon: Code2, permission: PERMISSIONS.KEYS_READ },
    ],
  },
];

const NO_NAV_HOME = "/account";

export function homePath(permissions: readonly Permission[]): string {
  const first = NAV.flatMap((section) => section.items).find((item) => hasPerm(permissions, item.permission));
  return first?.href ?? NO_NAV_HOME;
}
