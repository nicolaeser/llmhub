"use client";

import { Button, Chip, Table } from "@heroui/react";
import { Layers, Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import ConfirmDialog from "@/components/console/confirm-dialog";
import EmptyState from "@/components/console/empty-state";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import { refKey, sectionSummaries } from "@/lib/gateway/safety/policy-layers";
import { POLICY_SECTIONS } from "@/schemas/guardrails";
import type { PolicyOverrideView, PolicySection, PolicyTarget } from "@/types/guardrails";
import { SectionChip } from "@/components/guardrails/policy-labels";

function SectionCell({ row, section }: { row: PolicyOverrideView; section: PolicySection }) {
  const t = useTranslations("Guardrails");
  const summary = sectionSummaries(row).find((entry) => entry.section === section);
  return summary ? <SectionChip summary={summary} /> : <span className="text-sm text-muted">{t("inherited")}</span>;
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
  onRemove,
}: {
  overrides: PolicyOverrideView[];
  canManage: boolean;
  canAdd: boolean;
  pending: boolean;
  onAdd: () => void;
  onEdit: (row: PolicyOverrideView) => void;
  onRemove: (row: PolicyOverrideView) => void;
}) {
  const t = useTranslations("Guardrails");
  const tCommon = useTranslations("Common");

  function actions(row: PolicyOverrideView) {
    return (
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
    );
  }

  const addButton =
    canManage && canAdd ? (
      <Button onPress={onAdd}>
        <Plus size={16} aria-hidden />
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
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted">{t("overrides.hint")}</p>
        {addButton}
      </div>
      <RowCards label={t("overrides.title")}>
        {overrides.map((row) => (
          <RowCard
            key={refKey(row.target)}
            title={row.target.alias}
            description={[t("scopeLabel", { scope: row.target.scope }), ...row.target.path].join(" · ")}
            details={POLICY_SECTIONS.map((section) => ({
              label: t("section", { section }),
              value: <SectionCell row={row} section={section} />,
            }))}
            actions={canManage ? actions(row) : undefined}
          />
        ))}
      </RowCards>
      <Table aria-label={t("overrides.title")} className={TABLE_FROM_LG}>
        <Table.ScrollContainer>
          <Table.Content aria-label={t("overrides.title")}>
            <Table.Header>
              <Table.Column isRowHeader>{t("overrides.target")}</Table.Column>
              {POLICY_SECTIONS.map((section) => (
                <Table.Column key={section}>{t("section", { section })}</Table.Column>
              ))}
              {canManage ? <Table.Column>{tCommon("actions")}</Table.Column> : null}
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
                  {canManage ? (
                    <Table.Cell>
                      <div className="flex items-center gap-1">{actions(row)}</div>
                    </Table.Cell>
                  ) : null}
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
    </div>
  );
}
