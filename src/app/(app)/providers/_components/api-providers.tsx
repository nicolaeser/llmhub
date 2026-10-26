"use client";

import { Button, Chip, Table } from "@heroui/react";
import { Boxes, CircleCheck, CirclePause, Download, KeyRound, Pause, Pencil, Play, Plug, Plus, Unplug } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import EmptyState from "@/components/console/empty-state";
import IconTile from "@/components/console/icon-tile";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import StatCard from "@/components/console/stat-card";
import { InternalBadge } from "@/components/console/subscription-badge";
import { kindIcon } from "@/components/providers/kind-icons";
import { PROVIDER_CATALOG } from "@/lib/gateway/upstreams/provider-kinds";
import type { ProviderListActions, ProviderPresetUsage, ProviderView } from "@/types/providers";
import PolicyChips from "./policy-chips";
import RowMenu, { type RowMenuItem } from "./row-menu";
import { byProviderOrder, providerMenuActions, providerRow, type ProviderMenuAction } from "./provider-rows";
import { useProviderRowActions } from "./use-provider-row-actions";

const MENU_ICONS = {
  edit: Pencil,
  import: Download,
  pause: Pause,
  resume: Play,
  disconnect: Unplug,
} as const;

export default function ApiProviders({
  rows,
  presets,
  actions,
  canManage,
  onAdd,
}: {
  rows: ProviderView[];
  presets: ProviderPresetUsage | null;
  actions: ProviderListActions;
  canManage: boolean;
  onAdd: () => void;
}) {
  const t = useTranslations("Providers");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const rowActions = useProviderRowActions({ presets, onReplace: actions.replace, onRemove: actions.remove });

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

  function menuLabel(action: ProviderMenuAction) {
    if (action === "edit") return tCommon("edit");
    if (action === "import") return t("importModels");
    if (action === "pause") return t("menu.pause");
    if (action === "resume") return t("menu.resume");
    return t("menu.disconnect");
  }

  function runMenu(row: ProviderView, action: ProviderMenuAction) {
    if (action === "edit") actions.openForm(PROVIDER_CATALOG.find((spec) => spec.kind === row.kind) ?? null, row);
    if (action === "import") actions.openImport(row);
    if (action === "pause") rowActions.setEnabled(row, false);
    if (action === "resume") rowActions.setEnabled(row, true);
    if (action === "disconnect") rowActions.askDisconnect(row);
  }

  function menu(row: ProviderView) {
    const items: RowMenuItem<ProviderMenuAction>[] = providerMenuActions(canManage, row).map((action) => ({
      id: action,
      label: menuLabel(action),
      icon: MENU_ICONS[action],
      danger: action === "disconnect",
    }));
    return (
      <RowMenu
        label={t("actions", { name: row.name })}
        items={items}
        pending={rowActions.busy === row.id}
        onAction={(action) => runMenu(row, action)}
      />
    );
  }

  function credentialChip(row: ProviderView) {
    const { credential } = providerRow(row);
    return (
      <Chip
        size="sm"
        variant="soft"
        color={credential === "missing" ? "warning" : "default"}
        className="whitespace-nowrap"
      >
        {t("keyState", { state: credential })}
      </Chip>
    );
  }

  function statusChip(row: ProviderView) {
    const { active } = providerRow(row);
    return (
      <Chip size="sm" variant="soft" color={active ? "success" : "default"} className="whitespace-nowrap">
        {t("enabled.state", { enabled: String(active) })}
      </Chip>
    );
  }

  function modelCount(row: ProviderView) {
    return <span className="text-sm tabular-nums text-foreground">{format.number(providerRow(row).models)}</span>;
  }

  function dataHandling(row: ProviderView) {
    const names = presets?.[row.id] ?? [];
    return (
      <div className="min-w-0 space-y-1">
        <PolicyChips policy={row.policy} fallback={<span className="text-sm text-muted">{tCommon("none")}</span>} />
        {names.length ? (
          <p className="text-xs break-words text-muted">
            {t("presets.usedBy", { count: names.length, names: format.list(names) })}
          </p>
        ) : null}
      </div>
    );
  }

  function badges(row: ProviderView) {
    return providerRow(row).internal ? <InternalBadge /> : null;
  }

  const sorted = [...rows].sort(byProviderOrder);
  const summaries = rows.map(providerRow);
  const active = summaries.filter((row) => row.active).length;
  const missing = summaries.filter((row) => row.credential === "missing").length;
  const models = summaries.reduce((total, row) => total + row.models, 0);

  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-muted">{t("overview.intro")}</p>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard
          icon={CircleCheck}
          tone={active > 0 ? "success" : "neutral"}
          label={t("overview.active")}
          value={format.number(active)}
          hint={t("overview.total", { count: rows.length })}
        />
        <StatCard
          icon={CirclePause}
          tone="neutral"
          label={t("overview.paused")}
          value={format.number(rows.length - active)}
        />
        <StatCard
          icon={KeyRound}
          tone={missing > 0 ? "warning" : "neutral"}
          label={t("overview.missing")}
          value={format.number(missing)}
          hint={missing > 0 ? t("overview.missingHint") : undefined}
        />
        <StatCard icon={Boxes} tone="accent" label={t("overview.models")} value={format.number(models)} />
      </div>
      <RowCards label={t("tabs", { tab: "api" })}>
        {sorted.map((row) => (
          <RowCard
            key={row.id}
            title={row.name}
            description={t("kindName", { kind: row.kind })}
            aside={
              <>
                {statusChip(row)}
                {menu(row)}
              </>
            }
            chips={
              <>
                {credentialChip(row)}
                {badges(row)}
              </>
            }
            details={[
              { label: t("columns.models"), value: modelCount(row) },
              { label: t("columns.dataHandling"), value: dataHandling(row), wide: true },
            ]}
          />
        ))}
      </RowCards>
      <Table aria-label={t("tabs", { tab: "api" })} className={TABLE_FROM_LG}>
        <Table.ScrollContainer>
          <Table.Content aria-label={t("tabs", { tab: "api" })} className="min-w-[56rem]">
            <Table.Header>
              <Table.Column isRowHeader>{t("columns.provider")}</Table.Column>
              <Table.Column>{t("columns.credential")}</Table.Column>
              <Table.Column>{t("columns.models")}</Table.Column>
              <Table.Column>{t("columns.dataHandling")}</Table.Column>
              <Table.Column>{tCommon("status")}</Table.Column>
              {canManage ? <Table.Column>{tCommon("actions")}</Table.Column> : null}
            </Table.Header>
            <Table.Body>
              {sorted.map((row) => (
                <Table.Row key={row.id} id={row.id}>
                  <Table.Cell>
                    <div className="flex min-w-0 items-center gap-3">
                      <IconTile icon={kindIcon(row.kind)} tone={row.enabled ? "accent" : "neutral"} size="sm" />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium break-words">{row.name}</span>
                          {badges(row)}
                        </div>
                        <div className="text-xs text-muted">{t("kindName", { kind: row.kind })}</div>
                      </div>
                    </div>
                  </Table.Cell>
                  <Table.Cell>{credentialChip(row)}</Table.Cell>
                  <Table.Cell>{modelCount(row)}</Table.Cell>
                  <Table.Cell>{dataHandling(row)}</Table.Cell>
                  <Table.Cell>{statusChip(row)}</Table.Cell>
                  {canManage ? <Table.Cell>{menu(row)}</Table.Cell> : null}
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
      {canManage ? rowActions.dialogs : null}
    </div>
  );
}
