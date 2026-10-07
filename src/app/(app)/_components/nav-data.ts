import {
  Activity,
  BarChart3,
  Bell,
  BookOpen,
  Building2,
  Code2,
  Database,
  KeyRound,
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
import { PERMISSIONS } from "@/lib/auth/permissions";
import type { NavSection } from "@/types/console";

export const NAV: NavSection[] = [
  {
    id: "customers",
    labelKey: "sections.customers",
    items: [
      { href: "/companies", labelKey: "items.companies", icon: Building2, permission: PERMISSIONS.TENANCY_READ },
      { href: "/keys", labelKey: "items.keys", icon: KeyRound, permission: PERMISSIONS.KEYS_READ },
    ],
  },
  {
    id: "gateway",
    labelKey: "sections.gateway",
    items: [
      { href: "/playground", labelKey: "items.playground", icon: PlayCircle, permission: PERMISSIONS.PLAYGROUND_USE },
      { href: "/assistant", labelKey: "items.assistant", icon: Sparkles, permission: PERMISSIONS.ASSISTANT_USE },
      { href: "/providers", labelKey: "items.providers", icon: Plug, permission: PERMISSIONS.PROVIDERS_READ },
      { href: "/model-catalog", labelKey: "items.modelCatalog", icon: BookOpen, permission: PERMISSIONS.MODELS_READ },
      { href: "/models", labelKey: "items.models", icon: Network, permission: PERMISSIONS.MODELS_READ },
      { href: "/model-templates", labelKey: "items.modelTemplates", icon: ListChecks, permission: PERMISSIONS.MODELS_READ },
      { href: "/guardrails", labelKey: "items.guardrails", icon: Shield, permission: PERMISSIONS.SETTINGS_READ },
    ],
  },
  {
    id: "observe",
    labelKey: "sections.observe",
    items: [
      { href: "/usage", labelKey: "items.usage", icon: BarChart3, permission: PERMISSIONS.SPEND_READ },
      { href: "/logs", labelKey: "items.logs", icon: Activity, permission: PERMISSIONS.SPEND_READ },
    ],
  },
  {
    id: "access",
    labelKey: "sections.access",
    items: [
      { href: "/users", labelKey: "items.users", icon: User, permission: PERMISSIONS.USERS_READ },
      { href: "/roles", labelKey: "items.roles", icon: UserCog, permission: PERMISSIONS.ROLES_MANAGE },
    ],
  },
  {
    id: "developer",
    labelKey: "sections.developer",
    items: [
      { href: "/api-ref", labelKey: "items.apiRef", icon: Code2, permission: PERMISSIONS.KEYS_READ },
      { href: "/cache", labelKey: "items.cache", icon: Database, permission: PERMISSIONS.SETTINGS_READ },
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
];
