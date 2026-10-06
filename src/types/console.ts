import type { LucideIcon } from "lucide-react";
import type { Permission } from "@/types/auth";

type NavItem = {
  href: string;
  labelKey: string;
  icon: LucideIcon;
  permission: Permission;
};

export type NavSection = {
  id: string;
  labelKey: string;
  items: NavItem[];
};

export type PickerItem = { id: string; label: string; detail?: string };
