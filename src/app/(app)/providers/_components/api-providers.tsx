"use client";

import { useState } from "react";
import { Alert, Button, Chip, SearchField, Table } from "@heroui/react";
import { Download, Pause, Pencil, Play, Plug, Plus, Unplug } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import EmptyState from "@/components/console/empty-state";
import IconTile from "@/components/console/icon-tile";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import { InternalBadge } from "@/components/console/subscription-badge";
import { kindIcon } from "@/components/providers/kind-icons";
import { PROVIDER_CATALOG } from "@/lib/gateway/upstreams/provider-kinds";
import type { ProviderListActions, ProviderPresetUsage, ProviderView } from "@/types/providers";
import PolicyChips from "./policy-chips";
import RowMenu, { type RowMenuItem } from "@/components/providers/row-menu";
import {
  byProviderOrder,
  providerMatches,
  providerMenuActions,
  providerRow,
  providerStatus,
  type ProviderMenuAction,
} from "./provider-rows";
import { useProviderRowActions } from "./use-provider-row-actions";

const SEARCH_FROM = 6;

const STATUS_COLOR = { active: "success", paused: "default", missing: "warning" } as const;

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
  const [query, setQuery] = useState("");

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

  function credentialText(row: ProviderView) {
    const { credential } = providerRow(row);
    return credential === "missing" ? null : t("keyState", { state: credential });
  }

  function statusChip(row: ProviderView) {
    const status = providerStatus(row);
    return (
      <Chip size="sm" variant="soft" color={STATUS_COLOR[status]} className="whitespace-nowrap">
        {t("status", { status })}
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
        <PolicyChips policy={row.policy} fallback={<span className="text-sm text-muted">{t("dataHandling.unset")}</span>} />
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
  const searchable = rows.length >= SEARCH_FROM;
  const shown = searchable
    ? sorted.filter((row) => providerMatches(row, query, [t("kindName", { kind: row.kind })]))
    : sorted;
  const missing = rows.filter((row) => providerStatus(row) === "missing");

  function subtitle(row: ProviderView) {
    const credential = credentialText(row);
    return credential ? t("rowSubtitle", { kind: t("kindName", { kind: row.kind }), credential }) : t("kindName", { kind: row.kind });
  }

  return (
    <div className="space-y-5">
      <p className="max-w-3xl text-sm text-muted">{t("overview.intro")}</p>
      {missing.length ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{t("overview.missingTitle", { count: missing.length })}</Alert.Title>
            <Alert.Description>
              {t("overview.missingHint", { names: format.list(missing.map((row) => row.name)) })}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {searchable ? (
        <SearchField value={query} onChange={setQuery} aria-label={t("search")} className="w-full max-w-sm">
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder={t("search")} />
            <SearchField.ClearButton aria-label={tCommon("close")} />
          </SearchField.Group>
        </SearchField>
      ) : null}
      {shown.length === 0 ? (
        <EmptyState icon={Plug} title={t("noMatches")} />
      ) : (
        <>
          <RowCards label={t("tabs", { tab: "api" })}>
            {shown.map((row) => (
              <RowCard
                key={row.id}
                title={row.name}
                description={subtitle(row)}
                aside={
                  <>
                    {statusChip(row)}
                    {menu(row)}
                  </>
                }
                chips={badges(row)}
                details={[
                  { label: t("columns.models"), value: modelCount(row) },
                  { label: t("columns.dataHandling"), value: dataHandling(row), wide: true },
                ]}
              />
            ))}
          </RowCards>
          <Table aria-label={t("tabs", { tab: "api" })} className={TABLE_FROM_LG}>
            <Table.ScrollContainer>
              <Table.Content aria-label={t("tabs", { tab: "api" })} className="min-w-[48rem]">
                <Table.Header>
                  <Table.Column isRowHeader>{t("columns.provider")}</Table.Column>
                  <Table.Column>{tCommon("status")}</Table.Column>
                  <Table.Column>{t("columns.models")}</Table.Column>
                  <Table.Column>{t("columns.dataHandling")}</Table.Column>
                  {canManage ? <Table.Column>{tCommon("actions")}</Table.Column> : null}
                </Table.Header>
                <Table.Body>
                  {shown.map((row) => (
                    <Table.Row key={row.id} id={row.id}>
                      <Table.Cell>
                        <div className="flex min-w-0 items-center gap-3">
                          <IconTile icon={kindIcon(row.kind)} tone={row.enabled ? "accent" : "neutral"} size="sm" />
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-medium break-words">{row.name}</span>
                              {badges(row)}
                            </div>
                            <div className="text-xs text-muted">{subtitle(row)}</div>
                          </div>
                        </div>
                      </Table.Cell>
                      <Table.Cell>{statusChip(row)}</Table.Cell>
                      <Table.Cell>{modelCount(row)}</Table.Cell>
                      <Table.Cell>{dataHandling(row)}</Table.Cell>
                      {canManage ? <Table.Cell>{menu(row)}</Table.Cell> : null}
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        </>
      )}
      {canManage ? rowActions.dialogs : null}
    </div>
  );
}
