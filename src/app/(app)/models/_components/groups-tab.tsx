"use client";

import { useState, useTransition } from "react";
import { Button, Chip, SearchField, Table, toast, useOverlayState } from "@heroui/react";
import { BookOpen, Network, Pencil, Plus, Power, PowerOff, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { Link } from "@/i18n/routing";
import ConfirmDialog from "@/components/console/confirm-dialog";
import SubscriptionBadge, { InternalBadge } from "@/components/console/subscription-badge";
import EmptyState from "@/components/console/empty-state";
import PageStatus from "@/components/console/page-status";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import { useErrorToast } from "@/components/console/use-error-toast";
import RowMenu, { type RowMenuItem } from "@/components/providers/row-menu";
import { deleteModelGroupAction, loadModelsAction, setModelGroupEnabledAction } from "../_action";
import { useActionData } from "@/lib/hooks/use-action-data";
import { setSearchParams, useSearchParam } from "@/lib/hooks/use-search-param";
import { isActionFail } from "@/lib/http/action-result";
import { splitTag } from "@/lib/gateway/catalog/model-catalog";
import type { ModelGroupView, ProviderOpt } from "@/types/models";
import { hiddenFrom, routePool } from "@/lib/gateway/routing/route-pool";
import { modelRole } from "@/lib/models/model-role";
import { contextRange, contextWindowOf } from "./deployment-draft";
import { groupMatches } from "./group-summary";
import ModelGroupDialog from "./model-group-dialog";
import { useGroupSummary } from "./use-group-summary";

const SEARCH_FROM = 6;

type GroupAction = "edit" | "toggle" | "delete";

export default function GroupsTab() {
  const t = useTranslations("Models");
  const tCatalog = useTranslations("ModelCatalog");
  const tCommon = useTranslations("Common");
  const showError = useErrorToast();
  const format = useFormatter();
  const [editing, setEditing] = useState<ModelGroupView | null>(null);
  const [dialogKey, setDialogKey] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ModelGroupView | null>(null);
  const [, startChange] = useTransition();
  const groupParam = useSearchParam("group");
  const [typed, setTyped] = useState<string | null>(null);
  const query = typed ?? groupParam ?? "";
  const formState = useOverlayState();
  const removeState = useOverlayState();
  const page = useActionData<{ groups: ModelGroupView[]; providers: ProviderOpt[]; canManage: boolean }>(loadModelsAction);
  const { data, setData } = page;
  const summarize = useGroupSummary(data?.providers ?? []);

  function setGroups(update: (current: ModelGroupView[]) => ModelGroupView[]) {
    setData((current) => ({ ...current, groups: update(current.groups) }));
  }

  if (!data) {
    return <PageStatus state={page} />;
  }

  const { groups, providers, canManage } = data;
  const rows = groups.map((group) => ({
    group,
    text: summarize({
      deployments: group.deployments,
      strategy: group.strategy,
      fallbackGroups: group.fallbackGroups,
      overflowGroup: group.overflowGroup,
      billingMode: group.billingMode,
      priceInput: group.priceInput,
      priceOutput: group.priceOutput,
      priceWindows: group.priceWindows.length,
    }),
  }));
  const searchable = groups.length >= SEARCH_FROM || Boolean(groupParam);
  const shown = rows.filter((row) => groupMatches(row.group, row.text.summary.targets, searchable ? query : ""));

  function search(value: string) {
    setTyped(value);
    if (groupParam) setSearchParams({ group: null });
  }

  function pooledRoutes(group: ModelGroupView) {
    return group.deployments.map((dep) => ({
      kind: dep.kind,
      provider: providers.find((item) => item.id === dep.providerId) ?? null,
    }));
  }

  function groupChips(group: ModelGroupView) {
    const { tag } = splitTag(group.alias);
    const routes = pooledRoutes(group);
    const internal = hiddenFrom("api", routes);
    const subscription = routes.some((route) => routePool(route) === "subscription");
    if (!tag && !internal && !subscription) return null;
    return (
      <>
        {subscription ? <SubscriptionBadge /> : null}
        {internal ? <InternalBadge /> : null}
        {tag ? (
          <Chip size="sm" variant="soft" color="warning" className="whitespace-nowrap">
            {tCatalog("tag", { tag })}
          </Chip>
        ) : null}
      </>
    );
  }

  function openDialog(group: ModelGroupView | null) {
    setEditing(group);
    setDialogKey((n) => n + 1);
    formState.open();
  }

  function saved(group: ModelGroupView) {
    setGroups((cur) =>
      cur.some((g) => g.alias === group.alias)
        ? cur.map((g) => (g.alias === group.alias ? group : g))
        : [...cur, group].sort((a, b) => a.alias.localeCompare(b.alias)),
    );
  }

  function toggle(group: ModelGroupView) {
    setBusy(group.alias);
    startChange(async () => {
      const result = await setModelGroupEnabledAction({ alias: group.alias, enabled: !group.enabled });
      setBusy(null);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      saved(result);
      toast(t("toasts.enabled", { alias: result.alias, enabled: String(result.enabled) }), { variant: "success" });
    });
  }

  function remove() {
    if (!removing) return;
    const alias = removing.alias;
    setBusy(alias);
    startChange(async () => {
      const result = await deleteModelGroupAction(alias);
      setBusy(null);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      setGroups((cur) => cur.filter((g) => g.alias !== result.alias));
      toast(t("toasts.deleted"), { variant: "success" });
    });
  }

  function groupDetail(group: ModelGroupView) {
    return format.list([group.vendor, group.displayName].filter(Boolean), { type: "unit" });
  }

  function statusChip(group: ModelGroupView) {
    return (
      <Chip size="sm" variant="soft" color={group.enabled ? "success" : "default"} className="whitespace-nowrap">
        {t("enabledState", { enabled: String(group.enabled) })}
      </Chip>
    );
  }

  function menu(group: ModelGroupView) {
    if (!canManage) return null;
    const items: RowMenuItem<GroupAction>[] = [
      { id: "edit", label: tCommon("edit"), icon: Pencil },
      { id: "toggle", label: t("menu.toggle", { enabled: String(group.enabled) }), icon: group.enabled ? PowerOff : Power },
      { id: "delete", label: tCommon("delete"), icon: Trash2, danger: true },
    ];
    return (
      <RowMenu
        label={t("menu.label", { alias: group.alias })}
        items={items}
        pending={busy === group.alias}
        onAction={(action) => {
          if (action === "edit") openDialog(group);
          if (action === "toggle") toggle(group);
          if (action === "delete") {
            setRemoving(group);
            removeState.open();
          }
        }}
      />
    );
  }

  function routing(row: (typeof rows)[number]) {
    return (
      <div className="min-w-0 space-y-1">
        <p className="text-sm break-words text-foreground">{row.text.sentence}</p>
        {row.text.pricing ? <p className="text-xs break-words text-muted">{row.text.pricing}</p> : null}
      </div>
    );
  }

  function contextLabel(group: ModelGroupView) {
    const range = contextRange(group.deployments.map((dep) => contextWindowOf(providers, dep.providerId, dep.model)));
    return (
      <div className="min-w-0">
        <span className={range.range === "none" ? "text-sm text-muted" : "text-sm whitespace-nowrap"}>
          {t("contextSummary", range)}
        </span>
        {range.borrowed === "none" ? null : (
          <p className="text-xs text-muted">{t("contextEstimated", { borrowed: range.borrowed })}</p>
        )}
      </div>
    );
  }

  const createButton = canManage ? (
    <Button onPress={() => openDialog(null)}>
      <Plus size={16} aria-hidden />
      {t("add")}
    </Button>
  ) : null;

  function emptyHint() {
    if (providers.length > 0) return t("empty");
    return t.rich("needProvider", {
      providers: (chunks) => (
        <Link href="/providers" className="text-accent">
          {chunks}
        </Link>
      ),
    });
  }

  return (
    <div className="space-y-5">
      {groups.length === 0 ? (
        <EmptyState
          icon={Network}
          title={t("emptyTitle")}
          description={canManage ? emptyHint() : undefined}
          action={
            canManage && providers.length === 0 ? (
              <Link href="/providers" className="text-sm font-medium text-accent">
                {t("connectProvider")}
              </Link>
            ) : (
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="secondary" onPress={() => setSearchParams({ tab: null, group: null })}>
                  <BookOpen size={16} aria-hidden />
                  {t("openCatalog")}
                </Button>
                {createButton}
              </div>
            )
          }
        />
      ) : (
        <>
          <p className="max-w-3xl text-sm text-muted">{t("intro")}</p>
          <div className="flex flex-wrap items-center justify-between gap-3">
            {searchable ? (
              <SearchField value={query} onChange={search} aria-label={t("search")} className="w-full max-w-sm">
                <SearchField.Group>
                  <SearchField.SearchIcon />
                  <SearchField.Input placeholder={t("search")} />
                  <SearchField.ClearButton aria-label={tCommon("close")} />
                </SearchField.Group>
              </SearchField>
            ) : (
              <p className="text-sm text-muted tabular-nums">{t("count", { count: groups.length })}</p>
            )}
            {createButton}
          </div>
          {shown.length === 0 ? (
            <EmptyState icon={Network} title={t("noMatches")} />
          ) : (
            <>
              <RowCards label={t("tab", { tab: "groups" })}>
                {shown.map((row) => (
                  <RowCard
                    key={row.group.alias}
                    title={<span className="font-mono">{row.group.alias}</span>}
                    description={row.group.vendor || row.group.displayName ? groupDetail(row.group) : undefined}
                    aside={
                      <>
                        {statusChip(row.group)}
                        {menu(row.group)}
                      </>
                    }
                    chips={groupChips(row.group)}
                    details={[
                      { label: t("columns.routing"), value: routing(row), wide: true },
                      { label: t("columns.context"), value: contextLabel(row.group), wide: true },
                    ]}
                  />
                ))}
              </RowCards>
              <Table aria-label={t("tab", { tab: "groups" })} className={TABLE_FROM_LG}>
                <Table.ScrollContainer>
                  <Table.Content aria-label={t("tab", { tab: "groups" })} className="min-w-3xl">
                    <Table.Header>
                      <Table.Column isRowHeader>{t("columns.alias")}</Table.Column>
                      <Table.Column>{t("columns.routing")}</Table.Column>
                      <Table.Column>{t("columns.context")}</Table.Column>
                      <Table.Column>{t("columns.enabled")}</Table.Column>
                      {canManage ? <Table.Column>{tCommon("actions")}</Table.Column> : null}
                    </Table.Header>
                    <Table.Body>
                      {shown.map((row) => (
                        <Table.Row key={row.group.alias} id={row.group.alias}>
                          <Table.Cell>
                            <div className="min-w-0 space-y-1">
                              <p className="font-mono text-sm font-medium break-words text-foreground">
                                {row.group.alias}
                              </p>
                              {row.group.vendor || row.group.displayName ? (
                                <p className="text-xs break-words text-muted">{groupDetail(row.group)}</p>
                              ) : null}
                              {groupChips(row.group) ? (
                                <div className="flex flex-wrap gap-1">{groupChips(row.group)}</div>
                              ) : null}
                            </div>
                          </Table.Cell>
                          <Table.Cell>
                            <div className="max-w-md">{routing(row)}</div>
                          </Table.Cell>
                          <Table.Cell>{contextLabel(row.group)}</Table.Cell>
                          <Table.Cell>{statusChip(row.group)}</Table.Cell>
                          {canManage ? <Table.Cell>{menu(row.group)}</Table.Cell> : null}
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table.Content>
                </Table.ScrollContainer>
              </Table>
            </>
          )}
        </>
      )}

      {canManage ? (
        <>
          <ModelGroupDialog
            key={dialogKey}
            state={formState}
            editing={editing}
            providers={providers}
            models={groups.map((group) => ({
              alias: group.alias,
              label: group.displayName || group.alias,
              role: modelRole([...group.deployments.map((deployment) => deployment.model), group.alias, group.displayName]),
            }))}
            onSaved={saved}
          />
          <ConfirmDialog
            state={removeState}
            title={t("removeConfirm", { alias: removing?.alias ?? "" })}
            description={t("removeHint", { alias: removing?.alias ?? "" })}
            confirmLabel={tCommon("delete")}
            cancelLabel={tCommon("cancel")}
            pending={busy !== null && busy === removing?.alias}
            onConfirm={remove}
          />
        </>
      ) : null}
    </div>
  );
}
