"use client";

import { useState } from "react";
import { Button, Chip, SearchField, Table } from "@heroui/react";
import { ArrowRight, Layers, Pencil, Plus, SearchX, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import ConfirmDialog from "@/components/console/confirm-dialog";
import EmptyState from "@/components/console/empty-state";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import { SectionChip, SectionDetail, useSectionText } from "@/components/guardrails/policy-labels";
import { refKey } from "@/lib/gateway/safety/policy-layers";
import type { PolicyOverrideView, PolicyTarget } from "@/types/guardrails";
import { overrideChanges, overrideMatches, sameSummary, type PolicyBook, type SectionChange } from "./policy-view";

const SEARCH_FROM = 6;

function ChangeList({ changes }: { changes: SectionChange[] }) {
  const t = useTranslations("Guardrails");
  const sectionText = useSectionText();
  return (
    <ul className="space-y-1.5">
      {changes.map((change) => (
        <li key={change.section} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="font-medium text-foreground">{t("section", { section: change.section })}</span>
          {sameSummary(change.from, change.to) ? (
            <span className="text-muted">{t("overrides.same", { summary: sectionText(change.to) })}</span>
          ) : (
            <>
              <span className="text-muted">{sectionText(change.from)}</span>
              <ArrowRight size={14} className="text-muted" aria-hidden />
              <span className="sr-only">{t("overrides.becomes")}</span>
              <SectionChip summary={change.to} />
              <SectionDetail summary={change.to} />
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

function TargetName({ target }: { target: PolicyTarget }) {
  const t = useTranslations("Guardrails");
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium break-words text-foreground">{target.alias}</span>
        <Chip size="sm" variant="soft">
          {t("scopeLabel", { scope: target.scope })}
        </Chip>
      </div>
      {target.path.length ? <p className="text-xs break-words text-muted">{target.path.join(" › ")}</p> : null}
    </div>
  );
}

export default function PolicyOverrides({
  book,
  canManage,
  canAdd,
  pending,
  onAdd,
  onEdit,
  onRemove,
}: {
  book: PolicyBook;
  canManage: boolean;
  canAdd: boolean;
  pending: boolean;
  onAdd: () => void;
  onEdit: (row: PolicyOverrideView) => void;
  onRemove: (row: PolicyOverrideView) => void;
}) {
  const t = useTranslations("Guardrails");
  const tCommon = useTranslations("Common");
  const [query, setQuery] = useState("");
  const overrides = book.overrides;
  const visible = overrides.filter((row) => overrideMatches(row, query));

  function actions(row: PolicyOverrideView) {
    return (
      <>
        <Button size="sm" variant="secondary" onPress={() => onEdit(row)} aria-label={t("overrides.editFor", { alias: row.target.alias })}>
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
      <p className="max-w-3xl text-sm text-muted">{t("overrides.hint")}</p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {overrides.length >= SEARCH_FROM ? (
          <SearchField value={query} onChange={setQuery} aria-label={t("overrides.search")} className="w-full sm:max-w-xs">
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input placeholder={t("overrides.search")} />
              <SearchField.ClearButton aria-label={tCommon("close")} />
            </SearchField.Group>
          </SearchField>
        ) : (
          <p className="text-sm font-medium text-foreground">{t("overrides.count", { count: overrides.length })}</p>
        )}
        {addButton}
      </div>
      {visible.length === 0 ? (
        <EmptyState icon={SearchX} title={t("overrides.noMatches")} description={t("overrides.noMatchesHint")} />
      ) : (
        <>
          <RowCards label={t("overrides.title")}>
            {visible.map((row) => (
              <RowCard
                key={refKey(row.target)}
                title={row.target.alias}
                description={[t("scopeLabel", { scope: row.target.scope }), ...row.target.path].join(" · ")}
                details={[
                  { label: t("overrides.changes"), value: <ChangeList changes={overrideChanges(book, row)} />, wide: true },
                ]}
                actions={canManage ? actions(row) : undefined}
              />
            ))}
          </RowCards>
          <Table aria-label={t("overrides.title")} className={TABLE_FROM_LG}>
            <Table.ScrollContainer>
              <Table.Content aria-label={t("overrides.title")}>
                <Table.Header>
                  <Table.Column isRowHeader>{t("overrides.target")}</Table.Column>
                  <Table.Column>{t("overrides.changes")}</Table.Column>
                  {canManage ? <Table.Column>{tCommon("actions")}</Table.Column> : null}
                </Table.Header>
                <Table.Body>
                  {visible.map((row) => (
                    <Table.Row key={refKey(row.target)} id={refKey(row.target)}>
                      <Table.Cell>
                        <TargetName target={row.target} />
                      </Table.Cell>
                      <Table.Cell>
                        <ChangeList changes={overrideChanges(book, row)} />
                      </Table.Cell>
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
        </>
      )}
    </div>
  );
}
