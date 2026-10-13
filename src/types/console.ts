import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { Permission } from "@/types/auth";

type NavItem = {
  href: string;
  labelKey: string;
  icon: LucideIcon;
  permission: Permission | readonly Permission[];
};

export type NavSection = {
  id: string;
  labelKey: string;
  items: NavItem[];
};

export type PickerItem = { id: string; label: string; detail?: string };

export type Tone = "accent" | "success" | "warning" | "danger" | "neutral";

export type PageTab = { id: string; label: string; panel: ReactNode };
