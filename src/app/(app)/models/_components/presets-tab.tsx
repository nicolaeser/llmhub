"use client";

import { useState, useTransition } from "react";
import { Alert, Button, Chip, Table, toast, useOverlayState } from "@heroui/react";
import { ListChecks, Pencil, Plus, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import ConfirmDialog from "@/components/console/confirm-dialog";
import EmptyState from "@/components/console/empty-state";
import PageStatus from "@/components/console/page-status";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import { useErrorToast } from "@/components/console/use-error-toast";
import { templateModels } from "@/lib/gateway/access/model-policy";
import { useActionData } from "@/lib/hooks/use-action-data";
import { isActionFail } from "@/lib/http/action-result";
import type { ModelTemplateView } from "@/types/model-templates";
import { deleteTemplateAction, loadTemplatesAction } from "../_action";
import PresetDialog from "./preset-dialog";

type RuleChip = { id: string; label: string; warning?: boolean };

export default function PresetsTab() {
  const t = useTranslations("ModelTemplates");
  const tCommon = useTranslations("Common");
  const showError = useErrorToast();
  const format = useFormatter();
  const [editing, setEditing] = useState<ModelTemplateView | null>(null);
  const [dialogKey, setDialogKey] = useState(0);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [, startDelete] = useTransition();
  const formState = useOverlayState();
  const page = useActionData(loadTemplatesAction);
  const { data, setData } = page;

  if (!data) {
    return <PageStatus state={page} />;
  }

  const { templates, policies, providers, canManage } = data;
  const known = new Set(providers.map((provider) => provider.id));

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

  function remove(id: string) {
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

  function ruleChips(template: ModelTemplateView): RuleChip[] {
    const removed = template.providerIds.filter((id) => !known.has(id)).length;
    const chips: (RuleChip | null)[] = [
      template.zdrOnly ? { id: "zdr", label: t("rule.zdr") } : null,
      template.noTrainingOnly ? { id: "noTraining", label: t("rule.noTraining") } : null,
      template.maxRetentionDays !== null
        ? { id: "retention", label: t("rule.retention", { days: template.maxRetentionDays }) }
        : null,
      template.regions.length
        ? {
            id: "regions",
            label: t("rule.regions", {
              regions: format.list(template.regions.map((region) => t("region", { region }))),
            }),
          }
        : null,
      template.providerIds.length > removed
        ? { id: "providers", label: t("rule.providers", { count: template.providerIds.length - removed }) }
        : null,
      removed ? { id: "removed", label: t("rule.removed", { count: removed }), warning: true } : null,
      template.patterns.length
        ? { id: "patterns", label: t("rule.patterns", { patterns: format.list(template.patterns) }) }
        : null,
      template.models.length ? { id: "models", label: t("rule.models", { count: template.models.length }) } : null,
    ];
    return chips.filter((chip): chip is RuleChip => chip !== null);
  }

  function rules(template: ModelTemplateView) {
    const chips = ruleChips(template);
    if (!chips.length) return <span className="text-sm text-muted">{tCommon("none")}</span>;
    return (
      <span className="flex flex-wrap gap-1">
        {chips.map((chip) => (
          <Chip
            key={chip.id}
            size="sm"
            variant="soft"
            color={chip.warning ? "warning" : undefined}
            className="max-w-full break-words"
          >
            {chip.label}
          </Chip>
        ))}
      </span>
    );
  }

  function matchLabel(template: ModelTemplateView) {
    return t("matchCount", { count: templateModels(template, policies).length });
  }

  function presetActions(template: ModelTemplateView) {
    return (
      <>
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label={t("editLabel", { name: template.name })}
          onPress={() => openDialog(template)}
        >
          <Pencil size={14} aria-hidden />
        </Button>
        <ConfirmDialog
          title={t("deleteConfirm", { name: template.name })}
          description={template.keyCount > 0 ? t("deleteInUse", { count: template.keyCount }) : t("deleteHint")}
          confirmLabel={tCommon("delete")}
          cancelLabel={tCommon("cancel")}
          pending={deleting === template.id}
          onConfirm={() => remove(template.id)}
        >
          <Button
            isIconOnly
            size="sm"
            variant="danger-soft"
            aria-label={t("deleteLabel", { name: template.name })}
            isPending={deleting === template.id}
          >
            <Trash2 size={14} aria-hidden />
          </Button>
        </ConfirmDialog>
      </>
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
      {templates.length ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-2xl text-sm text-muted">{t("subtitle")}</p>
          {createButton}
        </div>
      ) : null}

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
          <RowCards label={t("title")}>
            {templates.map((template) => (
              <RowCard
                key={template.id}
                title={template.name}
                description={template.description || undefined}
                aside={canManage ? presetActions(template) : undefined}
                chips={rules(template)}
                details={[
                  { label: t("columns.models"), value: matchLabel(template) },
                  { label: t("columns.keys"), value: t("keyCount", { count: template.keyCount }) },
                ]}
              />
            ))}
          </RowCards>
          <Table aria-label={t("title")} className={TABLE_FROM_LG}>
            <Table.ScrollContainer>
              <Table.Content aria-label={t("title")} className="min-w-3xl">
                <Table.Header>
                  <Table.Column isRowHeader>{t("columns.name")}</Table.Column>
                  <Table.Column>{t("columns.rules")}</Table.Column>
                  <Table.Column>{t("columns.models")}</Table.Column>
                  <Table.Column>{t("columns.keys")}</Table.Column>
                  {canManage ? <Table.Column>{tCommon("actions")}</Table.Column> : null}
                </Table.Header>
                <Table.Body>
                  {templates.map((template) => (
                    <Table.Row key={template.id} id={template.id}>
                      <Table.Cell>
                        <div className="font-medium break-words">{template.name}</div>
                        {template.description ? (
                          <div className="text-xs break-words text-muted">{template.description}</div>
                        ) : null}
                      </Table.Cell>
                      <Table.Cell>{rules(template)}</Table.Cell>
                      <Table.Cell className="whitespace-nowrap tabular-nums">{matchLabel(template)}</Table.Cell>
                      <Table.Cell className="whitespace-nowrap tabular-nums">
                        {t("keyCount", { count: template.keyCount })}
                      </Table.Cell>
                      {canManage ? (
                        <Table.Cell>
                          <div className="flex gap-1">{presetActions(template)}</div>
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

      <PresetDialog
        key={dialogKey}
        state={formState}
        editing={editing}
        policies={policies}
        providers={providers}
        onSaved={saved}
      />
    </div>
  );
}
