"use client";

import { useState, useTransition } from "react";
import { Alert, Button, Chip, SearchField, Table, toast, useOverlayState } from "@heroui/react";
import { ListChecks, Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import ConfirmDialog from "@/components/console/confirm-dialog";
import EmptyState from "@/components/console/empty-state";
import PageStatus from "@/components/console/page-status";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import { useErrorToast } from "@/components/console/use-error-toast";
import RowMenu, { type RowMenuItem } from "@/components/providers/row-menu";
import { useActionData } from "@/lib/hooks/use-action-data";
import { isActionFail } from "@/lib/http/action-result";
import type { ModelTemplateView } from "@/types/model-templates";
import { deleteTemplateAction, loadTemplatesAction } from "../_action";
import PresetDialog from "./preset-dialog";
import { presetMatches } from "./preset-summary";
import { usePresetSummary, type PresetSummaryText } from "./use-preset-summary";

const SEARCH_FROM = 6;

type PresetAction = "edit" | "delete";

type PresetRow = { template: ModelTemplateView; text: PresetSummaryText };

export default function PresetsTab() {
  const t = useTranslations("ModelTemplates");
  const tCommon = useTranslations("Common");
  const showError = useErrorToast();
  const [editing, setEditing] = useState<ModelTemplateView | null>(null);
  const [dialogKey, setDialogKey] = useState(0);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ModelTemplateView | null>(null);
  const [query, setQuery] = useState("");
  const [, startDelete] = useTransition();
  const formState = useOverlayState();
  const removeState = useOverlayState();
  const page = useActionData(loadTemplatesAction);
  const { data, setData } = page;
  const summarize = usePresetSummary(data?.policies ?? [], data?.providers ?? []);

  if (!data) {
    return <PageStatus state={page} />;
  }

  const { templates, policies, providers, canManage } = data;
  const rows: PresetRow[] = templates.map((template) => ({ template, text: summarize(template) }));
  const searchable = templates.length >= SEARCH_FROM;
  const shown = searchable
    ? rows.filter((row) => presetMatches(row.template, row.text.summary, query))
    : rows;

  function setTemplates(update: (current: ModelTemplateView[]) => ModelTemplateView[]) {
    setData((current) => ({ ...current, templates: update(current.templates) }));
  }

  function openDialog(template: ModelTemplateView | null) {
    setEditing(template);
    setDialogKey((n) => n + 1);
    formState.open();
  }

  function saved(template: ModelTemplateView) {
    setTemplates((current) =>
      current.some((row) => row.id === template.id)
        ? current.map((row) => (row.id === template.id ? template : row))
        : [...current, template].sort((a, b) => a.name.localeCompare(b.name)),
    );
  }

  function remove() {
    if (!removing) return;
    const id = removing.id;
    setDeleting(id);
    startDelete(async () => {
      const result = await deleteTemplateAction(id);
      setDeleting(null);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      setTemplates((current) => current.filter((row) => row.id !== result.id));
      toast(t("toasts.deleted"), { variant: "success" });
    });
  }

  function summary(row: PresetRow) {
    const { removed } = row.text.summary;
    return (
      <div className="min-w-0 space-y-1">
        <p className="text-sm break-words text-foreground">{row.text.sentence}</p>
        {removed ? (
          <Chip size="sm" variant="soft" color="warning" className="whitespace-nowrap">
            {t("rule.removed", { count: removed })}
          </Chip>
        ) : null}
      </div>
    );
  }

  function keys(template: ModelTemplateView) {
    return <span className="text-sm whitespace-nowrap tabular-nums">{t("keyCount", { count: template.keyCount })}</span>;
  }

  function menu(template: ModelTemplateView) {
    if (!canManage) return null;
    const items: RowMenuItem<PresetAction>[] = [
      { id: "edit", label: tCommon("edit"), icon: Pencil },
      { id: "delete", label: tCommon("delete"), icon: Trash2, danger: true },
    ];
    return (
      <RowMenu
        label={t("actionsLabel", { name: template.name })}
        items={items}
        pending={deleting === template.id}
        onAction={(action) => {
          if (action === "edit") openDialog(template);
          if (action === "delete") {
            setRemoving(template);
            removeState.open();
          }
        }}
      />
    );
  }

  const createButton = canManage ? (
    <Button onPress={() => openDialog(null)}>
      <Plus size={16} aria-hidden />
      {t("add")}
    </Button>
  ) : undefined;

  return (
    <div className="space-y-5">
      {canManage ? null : (
        <Alert status="accent">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{t("readOnly")}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {templates.length === 0 ? (
        <EmptyState icon={ListChecks} title={t("emptyTitle")} description={t("empty")} action={createButton} />
      ) : (
        <>
          <p className="max-w-3xl text-sm text-muted">{t("subtitle")}</p>
          <div className="flex flex-wrap items-center justify-between gap-3">
            {searchable ? (
              <SearchField value={query} onChange={setQuery} aria-label={t("search")} className="w-full max-w-sm">
                <SearchField.Group>
                  <SearchField.SearchIcon />
                  <SearchField.Input placeholder={t("search")} />
                  <SearchField.ClearButton aria-label={tCommon("close")} />
                </SearchField.Group>
              </SearchField>
            ) : (
              <p className="text-sm text-muted tabular-nums">{t("count", { count: templates.length })}</p>
            )}
            {createButton}
          </div>
          {shown.length === 0 ? (
            <EmptyState icon={ListChecks} title={t("noMatches")} />
          ) : (
            <>
              <RowCards label={t("title")}>
                {shown.map((row) => (
                  <RowCard
                    key={row.template.id}
                    title={row.template.name}
                    description={row.template.description || undefined}
                    aside={menu(row.template)}
                    details={[
                      { label: t("columns.allows"), value: summary(row), wide: true },
                      { label: t("columns.keys"), value: keys(row.template) },
                    ]}
                  />
                ))}
              </RowCards>
              <Table aria-label={t("title")} className={TABLE_FROM_LG}>
                <Table.ScrollContainer>
                  <Table.Content aria-label={t("title")} className="min-w-3xl">
                    <Table.Header>
                      <Table.Column isRowHeader>{t("columns.name")}</Table.Column>
                      <Table.Column>{t("columns.allows")}</Table.Column>
                      <Table.Column>{t("columns.keys")}</Table.Column>
                      {canManage ? <Table.Column>{tCommon("actions")}</Table.Column> : null}
                    </Table.Header>
                    <Table.Body>
                      {shown.map((row) => (
                        <Table.Row key={row.template.id} id={row.template.id}>
                          <Table.Cell>
                            <div className="max-w-xs min-w-0">
                              <div className="font-medium break-words">{row.template.name}</div>
                              {row.template.description ? (
                                <div className="text-xs break-words text-muted">{row.template.description}</div>
                              ) : null}
                            </div>
                          </Table.Cell>
                          <Table.Cell>
                            <div className="max-w-lg">{summary(row)}</div>
                          </Table.Cell>
                          <Table.Cell>{keys(row.template)}</Table.Cell>
                          {canManage ? <Table.Cell>{menu(row.template)}</Table.Cell> : null}
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
          <PresetDialog
            key={dialogKey}
            state={formState}
            editing={editing}
            policies={policies}
            providers={providers}
            onSaved={saved}
          />
          <ConfirmDialog
            state={removeState}
            title={t("deleteConfirm", { name: removing?.name ?? "" })}
            description={
              removing && removing.keyCount > 0 ? t("deleteInUse", { count: removing.keyCount }) : t("deleteHint")
            }
            confirmLabel={tCommon("delete")}
            cancelLabel={tCommon("cancel")}
            pending={deleting !== null && deleting === removing?.id}
            onConfirm={remove}
          />
        </>
      ) : null}
    </div>
  );
}
