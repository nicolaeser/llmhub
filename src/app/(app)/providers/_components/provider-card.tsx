"use client";

import { Card, Chip } from "@heroui/react";
import { useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
import { InternalBadge } from "@/components/console/subscription-badge";
import PolicyChips from "./policy-chips";
import ProviderActions from "./provider-actions";
import ProviderToggle from "./provider-toggle";
import type { ProviderView } from "@/types/providers";
import { kindIcon } from "@/components/providers/kind-icons";

function keyState(row: ProviderView): string {
  if (!row.hasApiKey) return "missing";
  return row.vertex?.credential === "service_account" ? "service_account" : "stored";
}

export default function ProviderCard({
  row,
  canManage,
  onEdit,
  onImport,
  onDeleted,
  onToggled,
}: {
  row: ProviderView;
  canManage: boolean;
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
      <Card.Content className="gap-2">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
          <span
            className={
              row.hasApiKey ? "inline-flex items-center gap-1.5" : "inline-flex items-center gap-1.5 text-warning"
            }
          >
            <span
              className={`size-1.5 rounded-full ${row.hasApiKey ? "bg-success" : "bg-warning"}`}
              aria-hidden
            />
            {t("keyState", { state: keyState(row), account: "" })}
          </span>
          {row.discovered.length > 0 ? <span>{t("modelCount", { count: row.discovered.length })}</span> : null}
        </p>
        <PolicyChips policy={row.policy} lead={row.internal ? <InternalBadge /> : null} />
      </Card.Content>
      <Card.Footer className="mt-auto flex-wrap items-center justify-between gap-2">
        {canManage ? (
          <>
            <ProviderToggle row={row} onChanged={onToggled} />
            <ProviderActions row={row} onEdit={onEdit} onImport={onImport} onDeleted={onDeleted} />
          </>
        ) : (
          <Chip size="sm" variant="soft" color={row.enabled ? "success" : "default"} className="whitespace-nowrap">
            {t("enabled.state", { enabled: String(row.enabled) })}
          </Chip>
        )}
      </Card.Footer>
    </Card>
  );
}
