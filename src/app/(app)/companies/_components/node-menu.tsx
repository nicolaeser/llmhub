"use client";

import { BarChart3, FolderPlus, KeyRound, Pencil, Trash2, Wallet, Zap, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import RowMenu from "@/components/providers/row-menu";
import type { TenancyKind } from "@/types/structure";
import type { NodeAction } from "./tree-model";

const ICONS: Record<NodeAction, LucideIcon> = {
  edit: Pencil,
  budget: Wallet,
  boost: Zap,
  addProject: FolderPlus,
  createKey: KeyRound,
  usage: BarChart3,
  delete: Trash2,
};

export default function NodeMenu({
  kind,
  name,
  actions,
  onAction,
}: {
  kind: Exclude<TenancyKind, "org">;
  name: string;
  actions: NodeAction[];
  onAction: (action: NodeAction) => void;
}) {
  const t = useTranslations("Companies.menu");
  return (
    <RowMenu
      label={t("label", { name })}
      items={actions.map((action) => ({
        id: action,
        label: t("action", { action, kind }),
        icon: ICONS[action],
        danger: action === "delete",
      }))}
      onAction={onAction}
    />
  );
}
