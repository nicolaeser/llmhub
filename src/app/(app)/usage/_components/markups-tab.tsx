"use client";

import { useState, useTransition } from "react";
import { Alert, Button, Card, Chip, Disclosure, SearchField, Table, toast, useOverlayState } from "@heroui/react";
import {
  BadgePercent,
  Building2,
  FolderKanban,
  Globe,
  Pencil,
  Plus,
  ShoppingCart,
  Tag,
  Trash2,
  TrendingDown,
  TrendingUp,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import ConfirmDialog from "@/components/console/confirm-dialog";
import EmptyState from "@/components/console/empty-state";
import IconTile from "@/components/console/icon-tile";
import PageStatus from "@/components/console/page-status";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import StatCard from "@/components/console/stat-card";
import { useErrorToast } from "@/components/console/use-error-toast";
import RowMenu from "@/components/providers/row-menu";
import { deleteMarkupAction, loadMarkupsAction } from "../_action";
import { useActionData } from "@/lib/hooks/use-action-data";
import { isActionFail } from "@/lib/http/action-result";
import { isModelPattern, marginShare, markupScopeRank } from "@/lib/gateway/billing/markup-policy";
import { markupKindOf } from "@/lib/pricing/markup-view";
import type { MarkupRule, MarkupScope, MarkupView } from "@/types/pricing";
import MarkupDialog from "./markup-dialog";
import MarkupLookup from "./markup-lookup";

const SCOPE_ICONS = {
  all: Globe,
  org: Building2,
  team: Users,
  project: FolderKanban,
} as const satisfies Record<MarkupScope, LucideIcon>;

const PRECEDENCE = ["project", "team", "org", "all"] as const satisfies readonly MarkupScope[];

const KIND_COLORS = { markup: "success", discount: "warning", none: "default" } as const;

const SEARCH_FROM = 6;

type MarkupAction = "edit" | "delete";

export default function MarkupsTab() {
  const t = useTranslations("Markups");
  const showError = useErrorToast();
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const [editing, setEditing] = useState<MarkupView | null>(null);
  const [removing, setRemoving] = useState<MarkupView | null>(null);
  const [dialogKey, setDialogKey] = useState(0);
  const [query, setQuery] = useState("");
  const [deleting, startDelete] = useTransition();
  const formState = useOverlayState();
  const deleteState = useOverlayState();
  const page = useActionData(loadMarkupsAction);
  const { data, setData } = page;

  if (!data) {
    return <PageStatus state={page} stats={3} />;
  }

  const orgAlias = (id: string) => data.orgs.find((org) => org.id === id)?.alias ?? "";

  function target(rule: MarkupRule): { label: string; detail: string; missing: boolean } {
    if (!data || rule.scope === "all") return { label: t("scope", { scope: "all" }), detail: "", missing: false };
    const missing = { label: t("deletedTarget", { scope: rule.scope }), detail: rule.targetId, missing: true };
    if (rule.scope === "org") {
      const org = data.orgs.find((row) => row.id === rule.targetId);
      return org ? { label: org.alias, detail: t("scope", { scope: "org" }), missing: false } : missing;
    }
    if (rule.scope === "team") {
      const team = data.teams.find((row) => row.id === rule.targetId);
      return team
        ? {
            label: team.alias,
            detail: format.list([t("scope", { scope: "team" }), orgAlias(team.orgId)].filter(Boolean), { type: "unit" }),
            missing: false,
          }
        : missing;
    }
    const project = data.projects.find((row) => row.id === rule.targetId);
    if (!project) return missing;
    const team = data.teams.find((row) => row.id === project.teamId);
    return {
      label: project.alias,
      detail: format.list(
        [t("scope", { scope: "project" }), orgAlias(project.orgId), team?.alias ?? ""].filter(Boolean),
        { type: "unit" },
      ),
      missing: false,
    };
  }

  function describe(rule: MarkupRule): string {
    return t("ruleName", { target: target(rule).label, models: rule.model || t("allModels") });
  }

  function summary(rule: MarkupRule): string {
    return t("summary", {
      kind: markupKindOf(rule.percent),
      amount: Math.abs(rule.percent) / 100,
      scope: rule.scope === "all" ? "all" : "one",
      target: target(rule).label,
      models: rule.model ? "some" : "all",
      model: rule.model,
    });
  }

  function openDialog(markup: MarkupView | null) {
    setEditing(markup);
    setDialogKey((n) => n + 1);
    formState.open();
  }

  function saved(markup: MarkupView) {
    setData((current) => ({
      ...current,
      markups: current.markups.some((row) => row.id === markup.id)
        ? current.markups.map((row) => (row.id === markup.id ? markup : row))
        : [...current.markups, markup],
    }));
  }

  function remove(markup: MarkupView) {
    startDelete(async () => {
      const result = await deleteMarkupAction(markup.id);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      setData((current) => ({ ...current, markups: current.markups.filter((row) => row.id !== result.id) }));
      toast(t("toasts.deleted"), { variant: "success" });
    });
  }

  function onAction(markup: MarkupView, action: MarkupAction) {
    if (action === "edit") openDialog(markup);
    if (action === "delete") {
      setRemoving(markup);
      deleteState.open();
    }
  }

  const q = query.trim().toLowerCase();
  const sorted = [...data.markups].sort(
    (a, b) =>
      markupScopeRank(a.scope) - markupScopeRank(b.scope) ||
      target(a).label.localeCompare(target(b).label) ||
      a.model.localeCompare(b.model),
  );
  const markups = q
    ? sorted.filter((row) =>
        [target(row).label, row.model || t("allModels"), row.note].some((text) => text.toLowerCase().includes(q)),
      )
    : sorted;
  const margin = data.totals.sale - data.totals.purchase;
  const share = marginShare(data.totals.purchase, data.totals.sale);
  const createButton = data.canManage ? (
    <Button onPress={() => openDialog(null)}>
      <Plus size={16} aria-hidden />
      {t("add")}
    </Button>
  ) : null;

  function changeChip(markup: MarkupView) {
    const kind = markupKindOf(markup.percent);
    return (
      <Chip size="sm" variant="soft" color={KIND_COLORS[kind]}>
        <span className="tabular-nums">{format.number(markup.percent / 100, "markup")}</span>
      </Chip>
    );
  }

  function modelLabel(markup: MarkupView) {
    if (!markup.model) return <span className="text-muted">{t("allModels")}</span>;
    return (
      <span className="font-mono text-xs break-all">
        {markup.model}
        <span className="ml-2 font-sans text-muted">
          {t("modelKind", { kind: isModelPattern(markup.model) ? "pattern" : "one" })}
        </span>
      </span>
    );
  }

  function menu(markup: MarkupView) {
    if (!data?.canManage) return null;
    return (
      <RowMenu<MarkupAction>
        label={t("actions", { rule: describe(markup) })}
        items={[
          { id: "edit", label: tCommon("edit"), icon: Pencil },
          { id: "delete", label: tCommon("delete"), icon: Trash2, danger: true },
        ]}
        onAction={(action) => onAction(markup, action)}
      />
    );
  }

  function targetCell(markup: MarkupView) {
    const where = target(markup);
    return (
      <div className="flex min-w-0 items-center gap-3">
        <IconTile icon={SCOPE_ICONS[markup.scope]} size="sm" tone={where.missing ? "warning" : "accent"} />
        <div className="min-w-0">
          <p className="text-sm font-medium break-words text-foreground">{where.label}</p>
          {where.detail ? <p className="text-xs break-words text-muted">{where.detail}</p> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <p className="max-w-2xl text-sm text-muted">{t("subtitle")}</p>

      {data.canManage ? null : (
        <Alert status="accent">
          <Alert.Content>
            <Alert.Description>{t("readOnly")}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          icon={ShoppingCart}
          tone="neutral"
          label={t("summaryStats.purchase", { days: data.windowDays })}
          value={format.number(data.totals.purchase, "currency")}
        />
        <StatCard
          icon={Tag}
          label={t("summaryStats.sale", { days: data.windowDays })}
          value={format.number(data.totals.sale, "currency")}
        />
        <StatCard
          icon={margin < 0 ? TrendingDown : TrendingUp}
          tone={margin < 0 ? "danger" : "success"}
          label={t("summaryStats.margin", { days: data.windowDays })}
          value={
            share === null
              ? format.number(margin, "currency")
              : t("summaryStats.marginValue", { amount: margin, share })
          }
        />
      </div>

      {data.markups.length === 0 ? (
        <EmptyState
          icon={BadgePercent}
          title={t("emptyTitle")}
          description={t("empty")}
          action={createButton ?? undefined}
        />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {data.markups.length >= SEARCH_FROM ? (
              <SearchField value={query} onChange={setQuery} aria-label={t("search")} className="w-full sm:max-w-xs">
                <SearchField.Group>
                  <SearchField.SearchIcon />
                  <SearchField.Input placeholder={t("search")} />
                  <SearchField.ClearButton aria-label={t("clear")} />
                </SearchField.Group>
              </SearchField>
            ) : (
              <p className="text-sm text-muted">{t("count", { count: data.markups.length })}</p>
            )}
            {createButton}
          </div>
          {markups.length === 0 ? (
            <Card>
              <Card.Content>
                <p className="text-sm text-muted">{t("noMatches")}</p>
              </Card.Content>
            </Card>
          ) : (
            <>
              <RowCards label={t("title")}>
                {markups.map((markup) => (
                  <RowCard
                    key={markup.id}
                    title={summary(markup)}
                    description={markup.note || undefined}
                    aside={menu(markup)}
                    chips={changeChip(markup)}
                    details={[
                      { label: t("columns.scope"), value: targetCell(markup), wide: true },
                      { label: t("columns.model"), value: modelLabel(markup), wide: true },
                    ]}
                  />
                ))}
              </RowCards>
              <Table aria-label={t("title")} className={TABLE_FROM_LG}>
                <Table.ScrollContainer>
                  <Table.Content aria-label={t("title")} className="min-w-3xl">
                    <Table.Header>
                      <Table.Column isRowHeader>{t("columns.rule")}</Table.Column>
                      <Table.Column>{t("columns.scope")}</Table.Column>
                      <Table.Column>{t("columns.model")}</Table.Column>
                      <Table.Column>{t("columns.percent")}</Table.Column>
                      <Table.Column>
                        <span className="sr-only">{tCommon("actions")}</span>
                      </Table.Column>
                    </Table.Header>
                    <Table.Body>
                      {markups.map((markup) => (
                        <Table.Row key={markup.id} id={markup.id}>
                          <Table.Cell>
                            <div className="min-w-0 max-w-sm">
                              <p className="text-sm font-medium break-words text-foreground">{summary(markup)}</p>
                              {markup.note ? <p className="text-xs break-words text-muted">{markup.note}</p> : null}
                            </div>
                          </Table.Cell>
                          <Table.Cell>{targetCell(markup)}</Table.Cell>
                          <Table.Cell>{modelLabel(markup)}</Table.Cell>
                          <Table.Cell>{changeChip(markup)}</Table.Cell>
                          <Table.Cell>
                            <div className="flex justify-end">{menu(markup)}</div>
                          </Table.Cell>
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

      <div className="grid items-start gap-5 lg:grid-cols-2">
        <MarkupLookup
          markups={data.markups}
          orgs={data.orgs}
          teams={data.teams}
          projects={data.projects}
          models={data.models}
          describe={describe}
        />
        <Card>
          <Disclosure>
            <Disclosure.Heading>
              <Disclosure.Trigger className="flex w-full items-start justify-between gap-3 text-left">
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-foreground">{t("precedence.title")}</span>
                  <span className="block text-sm text-muted">{t("precedence.body")}</span>
                </span>
                <Disclosure.Indicator />
              </Disclosure.Trigger>
            </Disclosure.Heading>
            <Disclosure.Content>
              <Disclosure.Body className="space-y-4 pt-4">
                <ol className="grid gap-2 sm:grid-cols-2">
                  {PRECEDENCE.map((scope, index) => {
                    const Icon = SCOPE_ICONS[scope];
                    return (
                      <li key={scope} className="flex items-center gap-3 rounded-lg bg-default px-3 py-2">
                        <span className="text-xs font-semibold text-muted tabular-nums">
                          {format.number(index + 1, "integer")}
                        </span>
                        <Icon size={14} aria-hidden className="text-accent" />
                        <span className="text-sm font-medium">{t("scope", { scope })}</span>
                      </li>
                    );
                  })}
                </ol>
                <p className="text-sm text-muted">{t("precedence.models")}</p>
                <p className="text-sm text-muted">{t("precedence.billing")}</p>
              </Disclosure.Body>
            </Disclosure.Content>
          </Disclosure>
        </Card>
      </div>

      <MarkupDialog
        key={dialogKey}
        state={formState}
        editing={editing}
        orgs={data.orgs}
        teams={data.teams}
        projects={data.projects}
        models={data.models}
        onSaved={saved}
      />
      <ConfirmDialog
        state={deleteState}
        title={t("deleteConfirm", { rule: removing ? describe(removing) : "" })}
        description={t("deleteHint")}
        confirmLabel={tCommon("delete")}
        cancelLabel={tCommon("cancel")}
        pending={deleting}
        onConfirm={() => {
          if (removing) remove(removing);
        }}
      />
    </div>
  );
}
