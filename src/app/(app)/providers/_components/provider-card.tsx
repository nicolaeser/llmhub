"use client";

import { Card } from "@heroui/react";
import { useTranslations } from "next-intl";
import PolicyChips from "@/components/providers/policy-chips";
import ProviderActions from "@/components/providers/provider-actions";
import ProviderToggle from "@/components/providers/provider-toggle";
import type { ProviderView } from "@/types/providers";

export default function ProviderCard({
  row,
  onEdit,
  onImport,
  onDeleted,
  onToggled,
}: {
  row: ProviderView;
  onEdit: (row: ProviderView) => void;
  onImport: (row: ProviderView) => void;
  onDeleted: (id: string) => void;
  onToggled: (provider: ProviderView) => void;
}) {
  const t = useTranslations("Providers");
  const state = row.hasApiKey ? "stored" : "missing";

  return (
    <Card variant="secondary" className="flex-row flex-wrap items-center justify-between gap-2 px-3 py-2">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{row.name}</div>
        <div className="truncate text-xs text-muted">{t("keyState", { state, account: "" })}</div>
        <div className="mt-1 flex flex-wrap gap-1">
          <PolicyChips policy={row.policy} />
        </div>
        <div className="mt-2">
          <ProviderToggle row={row} onChanged={onToggled} />
        </div>
      </div>
      <ProviderActions row={row} onEdit={onEdit} onImport={onImport} onDeleted={onDeleted} />
    </Card>
  );
}
