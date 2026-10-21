"use client";

import { useState, useTransition } from "react";
import { Alert, Button, Table, toast, useOverlayState } from "@heroui/react";
import { ListChecks, Pencil, Plus, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import ConfirmDialog from "@/components/console/confirm-dialog";
import EmptyState from "@/components/console/empty-state";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import PageStatus from "@/components/console/page-status";
import { useErrorToast } from "@/components/console/use-error-toast";
import { deleteTemplateAction, loadTemplatesAction } from "../_action";
import { useActionData } from "@/lib/hooks/use-action-data";
import { isActionFail } from "@/lib/http/action-result";
import { templateModels } from "@/lib/gateway/access/model-policy";
import type { ModelTemplateView } from "@/types/model-templates";
import TemplateDialog from "./template-dialog";

export default function TemplatesTab() {
  const t = useTranslations("ModelTemplates");
  const showError = useErrorToast();
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const [editing, setEditing] = useState<ModelTemplateView | null>(null);
  const [dialogKey, setDialogKey] = useState(0);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [, startDelete] = useTransition();
  const formState = useOverlayState();
  const page = useActionData(loadTemplatesAction);
  const { data, setData } = page;

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

  function ruleSummary(template: ModelTemplateView): string {
    const parts = [
      template.zdrOnly ? t("rule.zdr") : null,
      template.noTrainingOnly ? t("rule.noTraining") : null,
      template.maxRetentionDays !== null ? t("rule.retention", { days: template.maxRetentionDays }) : null,
      template.regions.length
        ? t("rule.regions", {
            regions: format.list(template.regions.map((region) => t("region", { region }))),
          })
        : null,
      template.providerIds.length ? t("rule.providers", { count: template.providerIds.length }) : null,
      template.patterns.length ? t("rule.patterns", { patterns: format.list(template.patterns) }) : null,
      template.models.length ? t("rule.models", { count: template.models.length }) : null,
    ].filter((part): part is string => part !== null);
    return format.list(parts, { type: "unit" });
  }

  function templateActions(template: ModelTemplateView) {
    return (
      <>
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label={tCommon("edit")}
          onPress={() => openDialog(template)}
        >
          <Pencil size={14} aria-hidden />
        </Button>
        <ConfirmDialog
          title={t("deleteConfirm", { name: template.name })}
          description={template.keyCount > 0 ? t("deleteInUse", { count: template.keyCount }) : undefined}
          confirmLabel={tCommon("delete")}
          cancelLabel={tCommon("cancel")}
          pending={deleting === template.id}
          onConfirm={() => remove(template.id)}
        >
          <Button
            isIconOnly
            size="sm"
            variant="danger-soft"
            aria-label={tCommon("delete")}
            isPending={deleting === template.id}
          >
            <Trash2 size={14} aria-hidden />
          </Button>
        </ConfirmDialog>
      </>
    );
  }

  if (!data) {
    return <PageStatus state={page} />;
  }

  const { templates, policies, providers, canManage } = data;
  const createButton = canManage ? (
    <Button onPress={() => openDialog(null)}>
      <Plus size={16} aria-hidden />
      {t("add")}
    </Button>
  ) : undefined;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted">{t("subtitle")}</p>
        {templates.length ? createButton : null}
      </div>

      {canManage ? null : (
        <Alert status="accent">
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
                aside={canManage ? templateActions(template) : undefined}
                details={[
                  { label: t("columns.rules"), value: ruleSummary(template) || tCommon("none"), wide: true },
                  {
                    label: t("columns.models"),
                    value: t("matchCount", { count: templateModels(template, policies).length }),
                  },
                  { label: t("columns.keys"), value: t("keyCount", { count: template.keyCount }) },
                ]}
              />
            ))}
          </RowCards>
          <Table aria-label={t("title")} className={TABLE_FROM_LG}>
            <Table.ScrollContainer>
              <Table.Content aria-label={t("title")} className="min-w-[48rem]">
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
                        <div className="font-medium">{template.name}</div>
                        {template.description ? (
                          <div className="text-xs text-muted">{template.description}</div>
                        ) : null}
                      </Table.Cell>
                      <Table.Cell>
                        <span className="text-sm">{ruleSummary(template)}</span>
                      </Table.Cell>
                      <Table.Cell>{t("matchCount", { count: templateModels(template, policies).length })}</Table.Cell>
                      <Table.Cell>{t("keyCount", { count: template.keyCount })}</Table.Cell>
                      {canManage ? (
                        <Table.Cell>
                          <div className="flex gap-1">{templateActions(template)}</div>
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

      <TemplateDialog
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
