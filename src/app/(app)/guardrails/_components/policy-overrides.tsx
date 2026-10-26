"use client";

import { Button, Card, Chip, Table } from "@heroui/react";
import { Eye, Layers, Pencil, Plus, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import ConfirmDialog from "@/components/console/confirm-dialog";
import EmptyState from "@/components/console/empty-state";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import { refKey, sectionSummaries } from "@/lib/gateway/safety/policy-layers";
import { POLICY_SECTIONS } from "@/schemas/guardrails";
import type { PolicyOverrideView, PolicySection, PolicyTarget } from "@/types/guardrails";
import { SectionChip, SectionDetail } from "@/components/guardrails/policy-labels";

function SectionCell({ row, section }: { row: PolicyOverrideView; section: PolicySection }) {
  const t = useTranslations("Guardrails");
  const summary = sectionSummaries(row).find((entry) => entry.section === section);
  if (!summary) return <span className="text-sm text-muted">{t("inherited")}</span>;
  return (
    <div className="flex flex-col items-start gap-1">
      <SectionChip summary={summary} />
      <SectionDetail summary={summary} />
    </div>
  );
}

function TargetName({ target }: { target: PolicyTarget }) {
  const t = useTranslations("Guardrails");
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium break-words">{target.alias}</span>
        <Chip size="sm" variant="soft">
          {t("scopeLabel", { scope: target.scope })}
        </Chip>
      </div>
      {target.path.length ? <p className="text-xs break-words text-muted">{target.path.join(" › ")}</p> : null}
    </div>
  );
}

export default function PolicyOverrides({
  overrides,
  canManage,
  canAdd,
  pending,
  onAdd,
  onEdit,
  onInspect,
  onRemove,
}: {
  overrides: PolicyOverrideView[];
  canManage: boolean;
  canAdd: boolean;
  pending: boolean;
  onAdd: () => void;
  onEdit: (row: PolicyOverrideView) => void;
  onInspect: (target: PolicyTarget) => void;
  onRemove: (row: PolicyOverrideView) => void;
}) {
  const t = useTranslations("Guardrails");
  const tCommon = useTranslations("Common");
  const format = useFormatter();

  function updated(row: PolicyOverrideView) {
    return format.dateTime(new Date(row.updatedAt), { dateStyle: "medium" });
  }

  function actions(row: PolicyOverrideView) {
    return (
      <>
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label={t("overrides.inspect", { alias: row.target.alias })}
          onPress={() => onInspect(row.target)}
        >
          <Eye size={14} aria-hidden />
        </Button>
        {canManage ? (
          <>
            <Button size="sm" variant="secondary" onPress={() => onEdit(row)}>
              <Pencil size={14} aria-hidden />
              {tCommon("edit")}
            </Button>
            <ConfirmDialog
              title={t("overrides.removeConfirm", { alias: row.target.alias })}
              description={t("overrides.removeConfirmHint")}
              confirmLabel={t("overrides.remove")}
              cancelLabel={tCommon("cancel")}
              pending={pending}
              onConfirm={() => onRemove(row)}
            >
              <Button
                isIconOnly
                size="sm"
                variant="danger-soft"
                aria-label={t("overrides.removeFor", { alias: row.target.alias })}
                isDisabled={pending}
              >
                <Trash2 size={14} aria-hidden />
              </Button>
            </ConfirmDialog>
          </>
        ) : null}
      </>
    );
  }

  const addButton =
    canManage && canAdd ? (
      <Button size="sm" onPress={onAdd}>
        <Plus size={14} aria-hidden />
        {t("overrides.add")}
      </Button>
    ) : null;

  if (overrides.length === 0) {
    return (
      <EmptyState
        icon={Layers}
        title={t("overrides.emptyTitle")}
        description={t("overrides.emptyHint")}
        action={addButton}
      />
    );
  }

  return (
    <Card className="gap-4">
      <Card.Header className="flex-row flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <Card.Title>{t("overrides.title")}</Card.Title>
          <Card.Description>{t("overrides.hint")}</Card.Description>
        </div>
        {addButton}
      </Card.Header>
      <RowCards label={t("overrides.title")}>
        {overrides.map((row) => (
          <RowCard
            key={refKey(row.target)}
            variant="secondary"
            title={row.target.alias}
            description={[t("scopeLabel", { scope: row.target.scope }), ...row.target.path].join(" · ")}
            details={[
              ...POLICY_SECTIONS.map((section) => ({
                label: t("section", { section }),
                value: <SectionCell row={row} section={section} />,
              })),
              { label: t("overrides.updated"), value: updated(row) },
            ]}
            actions={actions(row)}
          />
        ))}
      </RowCards>
      <Table aria-label={t("overrides.title")} className={TABLE_FROM_LG}>
        <Table.ScrollContainer>
          <Table.Content>
            <Table.Header>
              <Table.Column isRowHeader>{t("overrides.target")}</Table.Column>
              {POLICY_SECTIONS.map((section) => (
                <Table.Column key={section}>{t("section", { section })}</Table.Column>
              ))}
              <Table.Column>{t("overrides.updated")}</Table.Column>
              <Table.Column>{tCommon("actions")}</Table.Column>
            </Table.Header>
            <Table.Body>
              {overrides.map((row) => (
                <Table.Row key={refKey(row.target)} id={refKey(row.target)}>
                  <Table.Cell>
                    <TargetName target={row.target} />
                  </Table.Cell>
                  {POLICY_SECTIONS.map((section) => (
                    <Table.Cell key={section}>
                      <SectionCell row={row} section={section} />
                    </Table.Cell>
                  ))}
                  <Table.Cell>
                    <span className="text-sm whitespace-nowrap text-muted">{updated(row)}</span>
                  </Table.Cell>
                  <Table.Cell>
                    <div className="flex flex-wrap items-center gap-1">{actions(row)}</div>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
    </Card>
  );
}
