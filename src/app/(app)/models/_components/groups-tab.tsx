"use client";

import { useState, useTransition } from "react";
import { Button, Chip, Label, SearchField, Switch, Table, toast, useOverlayState } from "@heroui/react";
import { BookOpen, Network, Plus, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { Link } from "@/i18n/routing";
import ConfirmDialog from "@/components/console/confirm-dialog";
import SubscriptionBadge, { InternalBadge } from "@/components/console/subscription-badge";
import EmptyState from "@/components/console/empty-state";
import PageStatus from "@/components/console/page-status";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import { useErrorToast } from "@/components/console/use-error-toast";
import {
  deleteModelGroupAction,
  loadModelsAction,
  setModelGroupEnabledAction,
} from "../_action";
import { useActionData } from "@/lib/hooks/use-action-data";
import { setSearchParams, useSearchParam } from "@/lib/hooks/use-search-param";
import { isActionFail } from "@/lib/http/action-result";
import { splitTag } from "@/lib/gateway/catalog/model-catalog";
import type { ModelGroupView, ProviderOpt } from "@/types/models";
import type { RoutePool } from "@/types/routing";
import { hiddenFrom, routePool } from "@/lib/gateway/routing/route-pool";
import { modelRole } from "@/lib/models/model-role";
import { contextRange, contextWindowOf } from "./deployment-draft";
import ModelGroupDialog from "./model-group-dialog";

function matchesGroup(group: ModelGroupView, query: string): boolean {
  if (!query) return true;
  return [group.alias, group.vendor, group.displayName].some((value) => value?.toLowerCase().includes(query));
}

export default function GroupsTab() {
  const t = useTranslations("Models");
  const tProviders = useTranslations("Providers");
  const tCatalog = useTranslations("ModelCatalog");
  const showError = useErrorToast();
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const [editing, setEditing] = useState<ModelGroupView | null>(null);
  const [dialogKey, setDialogKey] = useState(0);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [, startDelete] = useTransition();
  const [, startToggle] = useTransition();
  const groupParam = useSearchParam("group");
  const [typed, setTyped] = useState<string | null>(null);
  const query = typed ?? groupParam ?? "";
  const formState = useOverlayState();
  const page = useActionData<{ groups: ModelGroupView[]; providers: ProviderOpt[]; canManage: boolean }>(loadModelsAction);
  const { data, setData } = page;

  function setGroups(update: (current: ModelGroupView[]) => ModelGroupView[]) {
    setData((current) => ({ ...current, groups: update(current.groups) }));
  }

  if (!data) {
    return <PageStatus state={page} />;
  }

  const { groups, providers, canManage } = data;
  const needle = query.trim().toLowerCase();
  const shown = groups.filter((group) => matchesGroup(group, needle));

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

  function routes(group: ModelGroupView) {
    const seen = new Map<string, { name: string; pool: RoutePool }>();
    for (const route of pooledRoutes(group)) {
      const pool = routePool(route);
      const name =
        route.provider?.name ?? tProviders(pool === "subscription" ? "kindShort" : "kindName", { kind: route.kind });
      const key = `${name}:${pool}`;
      if (!seen.has(key)) seen.set(key, { name, pool });
    }
    return [...seen.entries()].map(([key, route]) => ({ key, ...route }));
  }

  function groupChips(group: ModelGroupView) {
    const { tag } = splitTag(group.alias);
    const internal = hiddenFrom("api", pooledRoutes(group));
    if (!tag && !internal) return null;
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        {internal ? <InternalBadge /> : null}
        {tag ? (
          <Chip size="sm" variant="soft" color="warning" className="whitespace-nowrap">
            {tCatalog("tag", { tag })}
          </Chip>
        ) : null}
      </span>
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

  function toggle(alias: string, enabled: boolean) {
    setToggling(alias);
    startToggle(async () => {
      const result = await setModelGroupEnabledAction({ alias, enabled });
      setToggling(null);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      saved(result);
      toast(t("toasts.enabled", { alias: result.alias, enabled: String(result.enabled) }), {
        variant: "success",
      });
    });
  }

  function remove(alias: string) {
    setDeleting(alias);
    startDelete(async () => {
      const result = await deleteModelGroupAction(alias);
      setDeleting(null);
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

  function billingLabel(group: ModelGroupView) {
    return t("billingSummary", {
      mode: group.billingMode,
      input: group.priceInput,
      output: group.priceOutput,
      windows: group.priceWindows.length,
    });
  }

  function contextLabel(group: ModelGroupView) {
    return t(
      "contextSummary",
      contextRange(group.deployments.map((dep) => contextWindowOf(providers, dep.providerId, dep.model))),
    );
  }

  function endpointList(group: ModelGroupView) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {routes(group).map((route) => (
          <span key={route.key} className="inline-flex items-center gap-1.5 text-sm">
            <span>{route.name}</span>
            {route.pool === "subscription" ? <SubscriptionBadge /> : null}
            {route.pool === "internal" ? <InternalBadge /> : null}
          </span>
        ))}
      </div>
    );
  }

  function enabledSwitch(group: ModelGroupView) {
    if (!canManage) {
      return (
        <Chip size="sm" variant="soft" color={group.enabled ? "success" : "default"} className="whitespace-nowrap">
          {t("enabledState", { enabled: String(group.enabled) })}
        </Chip>
      );
    }
    return (
      <Switch
        size="sm"
        isSelected={group.enabled}
        onChange={(next) => toggle(group.alias, next)}
        isDisabled={toggling === group.alias}
        aria-label={t("enabledToggle", { alias: group.alias })}
      >
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          <Label>{t("enabledState", { enabled: String(group.enabled) })}</Label>
        </Switch.Content>
      </Switch>
    );
  }

  function groupActions(group: ModelGroupView) {
    if (!canManage) return undefined;
    return (
      <>
        <Button size="sm" variant="secondary" aria-label={tCommon("edit")} onPress={() => openDialog(group)}>
          {tCommon("edit")}
        </Button>
        <ConfirmDialog
          title={t("removeConfirm", { alias: group.alias })}
          confirmLabel={tCommon("delete")}
          cancelLabel={tCommon("cancel")}
          pending={deleting === group.alias}
          onConfirm={() => remove(group.alias)}
        >
          <Button
            isIconOnly
            size="sm"
            variant="danger-soft"
            aria-label={tCommon("delete")}
            isPending={deleting === group.alias}
          >
            <Trash2 size={14} aria-hidden />
          </Button>
        </ConfirmDialog>
      </>
    );
  }

  const createButton = canManage ? (
    <Button
      aria-label={t("add")}
      onPress={() => openDialog(null)}
    >
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
    <div>
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
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SearchField value={query} onChange={search} aria-label={t("search")} className="w-full max-w-sm">
              <SearchField.Group>
                <SearchField.SearchIcon />
                <SearchField.Input placeholder={t("search")} />
                <SearchField.ClearButton aria-label={tCommon("close")} />
              </SearchField.Group>
            </SearchField>
            {createButton}
          </div>
          {shown.length === 0 ? (
            <EmptyState icon={Network} title={t("noMatches")} />
          ) : (
            <>
              <RowCards label={t("title")}>
                {shown.map((g) => (
                  <RowCard
                    key={g.alias}
                    title={g.alias}
                    description={g.vendor || g.displayName ? groupDetail(g) : undefined}
                    aside={enabledSwitch(g)}
                    chips={groupChips(g)}
                    details={[
                      { label: t("columns.strategy"), value: t("strategyLabel", { strategy: g.strategy }) },
                      { label: t("columns.overflow"), value: g.overflowGroup || tCommon("none") },
                      { label: t("columns.context"), value: contextLabel(g) },
                      { label: t("columns.billing"), value: billingLabel(g), wide: true },
                      { label: t("columns.endpoints"), value: endpointList(g), wide: true },
                    ]}
                    actions={groupActions(g)}
                  />
                ))}
              </RowCards>
              <Table aria-label={t("title")} className={TABLE_FROM_LG}>
                <Table.ScrollContainer>
                  <Table.Content className="min-w-4xl">
                    <Table.Header>
                      <Table.Column isRowHeader>{t("columns.alias")}</Table.Column>
                      <Table.Column>{t("columns.enabled")}</Table.Column>
                      <Table.Column>{t("columns.strategy")}</Table.Column>
                      <Table.Column>{t("columns.context")}</Table.Column>
                      <Table.Column>{t("columns.billing")}</Table.Column>
                      <Table.Column>{t("columns.endpoints")}</Table.Column>
                      <Table.Column>{t("columns.overflow")}</Table.Column>
                      {canManage ? <Table.Column>{tCommon("actions")}</Table.Column> : null}
                    </Table.Header>
                    <Table.Body>
                      {shown.map((g) => (
                        <Table.Row key={g.alias} id={g.alias}>
                          <Table.Cell>
                            {canManage ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="font-medium"
                                onPress={() => openDialog(g)}
                              >
                                {g.alias}
                              </Button>
                            ) : (
                              <span className="px-3 font-medium">{g.alias}</span>
                            )}
                            {groupChips(g)}
                            {g.vendor || g.displayName ? (
                              <div className="px-3 text-xs text-muted">{groupDetail(g)}</div>
                            ) : null}
                          </Table.Cell>
                          <Table.Cell>{enabledSwitch(g)}</Table.Cell>
                          <Table.Cell>{t("strategyLabel", { strategy: g.strategy })}</Table.Cell>
                          <Table.Cell>{contextLabel(g)}</Table.Cell>
                          <Table.Cell>{billingLabel(g)}</Table.Cell>
                          <Table.Cell>{endpointList(g)}</Table.Cell>
                          <Table.Cell>{g.overflowGroup || tCommon("none")}</Table.Cell>
                          {canManage ? (
                            <Table.Cell>
                              <div className="flex gap-1">{groupActions(g)}</div>
                            </Table.Cell>
                          ) : null}
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table.Content>
                </Table.ScrollContainer>
              </Table>
            </>
          )}
        </div>
      )}

      {canManage ? (
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
      ) : null}
    </div>
  );
}
