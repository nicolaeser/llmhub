"use client";

import { Button } from "@heroui/react";
import { Plug, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import EmptyState from "@/components/console/empty-state";
import { PROVIDER_CATALOG } from "@/lib/gateway/upstreams/provider-kinds";
import type { ProviderListActions, ProviderView } from "@/types/providers";
import ProviderCard from "./provider-card";

export default function ApiProviders({
  rows,
  actions,
  canManage,
  onAdd,
}: {
  rows: ProviderView[];
  actions: ProviderListActions;
  canManage: boolean;
  onAdd: () => void;
}) {
  const t = useTranslations("Providers");

  if (rows.length === 0) {
    return canManage ? (
      <EmptyState
        icon={Plug}
        title={t("emptyTitle")}
        description={t("empty")}
        action={
          <Button onPress={onAdd}>
            <Plus size={16} aria-hidden />
            {t("toolbar.add")}
          </Button>
        }
      />
    ) : (
      <EmptyState icon={Plug} title={t("noneTitle")} />
    );
  }

  return (
    <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
      {rows.map((row) => (
        <ProviderCard
          key={row.id}
          row={row}
          canManage={canManage}
          onEdit={(provider) =>
            actions.openForm(PROVIDER_CATALOG.find((spec) => spec.kind === provider.kind) ?? null, provider)
          }
          onImport={actions.openImport}
          onToggled={actions.replace}
          onDeleted={actions.remove}
        />
      ))}
    </div>
  );
}
