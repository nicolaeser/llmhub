import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { Permission } from "@/types/auth";

export type ScopeKind = "platform" | "company";

export type NavScope = ScopeKind | "both";

export type NavItem = {
  href: string;
  labelKey: string;
  scope: NavScope;
  icon: LucideIcon;
  permission: Permission | readonly Permission[];
};

export type NavSection = {
  id: string;
  labelKey: string;
  pinned?: boolean;
  items: NavItem[];
};

export type ScopeCompany = { id: string; alias: string };

export type ConsoleScope = { kind: "platform" } | ({ kind: "company" } & ScopeCompany);

export type ConsoleScopeState = {
  scope: ConsoleScope;
  companies: ScopeCompany[];
  canSwitch: boolean;
};

export type WorkspaceChange = { orgId: string | null; alias: string };

export type SetupLinks = Record<"provider" | "model", boolean>;

export type PickerItem = { id: string; label: string; detail?: string };

export type Tone = "accent" | "success" | "warning" | "danger" | "neutral";

export type PageTab = { id: string; label: string; panel: ReactNode };
