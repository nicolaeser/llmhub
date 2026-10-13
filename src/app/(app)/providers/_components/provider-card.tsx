"use client";

import { Card, Chip } from "@heroui/react";
import { useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
import PolicyChips from "./policy-chips";
import ProviderActions from "./provider-actions";
import ProviderToggle from "./provider-toggle";
import type { ProviderView } from "@/types/providers";
import { kindIcon } from "./kind-icons";

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

  return (
    <Card>
      <Card.Header className="flex-row items-start gap-3">
        <IconTile icon={kindIcon(row.kind)} tone={row.enabled ? "accent" : "neutral"} />
        <div className="min-w-0 flex-1">
          <Card.Title className="truncate">{row.name}</Card.Title>
          <Card.Description className="truncate">{t("kindName", { kind: row.kind })}</Card.Description>
        </div>
      </Card.Header>
      <Card.Content className="flex-row flex-wrap gap-1">
        <Chip size="sm" variant="soft" color={row.hasApiKey ? "success" : "warning"}>
          {t("keyState", { state: row.hasApiKey ? "stored" : "missing", account: "" })}
        </Chip>
        {row.discovered.length > 0 ? (
          <Chip size="sm" variant="soft">
            {t("modelCount", { count: row.discovered.length })}
          </Chip>
        ) : null}
        <PolicyChips policy={row.policy} />
      </Card.Content>
      <Card.Footer className="mt-auto flex-wrap items-center justify-between gap-2">
        <ProviderToggle row={row} onChanged={onToggled} />
        <ProviderActions row={row} onEdit={onEdit} onImport={onImport} onDeleted={onDeleted} />
      </Card.Footer>
    </Card>
  );
}
