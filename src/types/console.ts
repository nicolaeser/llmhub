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
  untitled?: boolean;
  items: NavItem[];
};

export type ScopeCompany = { id: string; alias: string };

export type ConsoleScope = { kind: "platform" } | ({ kind: "company" } & ScopeCompany);

export type ConsoleScopeState = {
  scope: ConsoleScope;
  companies: ScopeCompany[];
  canSwitch: boolean;
};

export type ConsoleAccess = { key: string };

export type WorkspaceChange = { orgId: string | null; alias: string };

export type SetupLinks = Record<"provider" | "model", boolean>;

export type PickerItem = { id: string; label: string; detail?: string; badge?: ReactNode };

export type Tone = "accent" | "success" | "warning" | "danger" | "neutral";

export type PageTab = { id: string; label: string; panel: ReactNode };

export type OverviewStepId = "provider" | "model" | "company" | "key" | "request";

export type OverviewStep = { id: OverviewStepId; done: boolean; href: string | null };

export type OverviewTotals = { spend: number; requests: number; errors: number };

export type OverviewAttention =
  | { kind: "errors"; id: string; count: number; href: string | null }
  | { kind: "budget"; id: string; target: "company" | "key"; name: string; ratio: number; href: string | null }
  | { kind: "provider"; id: string; name: string; failures: number; cooling: boolean; href: string | null };

export type OverviewConcept = "company" | "key" | "preset" | "guardrail";

export type OverviewPage = {
  steps: OverviewStep[];
  today: OverviewTotals | null;
  week: OverviewTotals | null;
  keys: { active: number; total: number } | null;
  providers: { online: number; total: number } | null;
  attention: OverviewAttention[];
  concepts: { id: OverviewConcept; href: string | null }[];
};
