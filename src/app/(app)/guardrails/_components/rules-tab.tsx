"use client";

import { useState, useTransition } from "react";
import { Button, Chip, SearchField, Table, toast, useOverlayState } from "@heroui/react";
import { ListChecks, Pencil, Plus, SearchX, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import ConfirmDialog from "@/components/console/confirm-dialog";
import EmptyState from "@/components/console/empty-state";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import { useErrorToast } from "@/components/console/use-error-toast";
import { MAX_RULES } from "@/lib/gateway/safety/guardrails";
import { isActionFail } from "@/lib/http/action-result";
import type { GuardrailPolicy, GuardrailRule } from "@/types/guardrails";
import { saveGuardrailPolicyAction } from "../_action";
import RuleDialog from "./rule-dialog";
import { useRuleSummary } from "./rule-summary";
import { ruleMatches, withoutRule } from "./rule-view";

const SEARCH_FROM = 6;

export default function RulesTab({
  policy,
  canManage,
  onSaved,
}: {
  policy: GuardrailPolicy;
  canManage: boolean;
  onSaved: (policy: GuardrailPolicy) => void;
}) {
  const t = useTranslations("Guardrails");
  const tCommon = useTranslations("Common");
  const showError = useErrorToast();
  const summary = useRuleSummary();
  const dialog = useOverlayState();
  const [editing, setEditing] = useState<{ rule: GuardrailRule | null; key: number }>({ rule: null, key: 0 });
  const [query, setQuery] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const [, start] = useTransition();
  const rules = policy.rules;
  const visible = rules.filter((rule) => ruleMatches(rule, query));
  const full = rules.length >= MAX_RULES;

  function open(rule: GuardrailRule | null) {
    setEditing((current) => ({ rule, key: current.key + 1 }));
    dialog.open();
  }

  function remove(rule: GuardrailRule) {
    setRemoving(rule.id);
    start(async () => {
      const result = await saveGuardrailPolicyAction({ ...policy, rules: withoutRule(rules, rule.id) });
      setRemoving(null);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onSaved(result.guardrails);
      toast(t("rules.removed"), { variant: "success" });
    });
  }

  function actions(rule: GuardrailRule) {
    if (!canManage) return null;
    return (
      <>
        <Button size="sm" variant="secondary" onPress={() => open(rule)} aria-label={t("rules.editFor", { name: rule.name })}>
          <Pencil size={14} aria-hidden />
          {tCommon("edit")}
        </Button>
        <ConfirmDialog
          title={t("rules.removeConfirm", { name: rule.name })}
          description={t("rules.removeConfirmHint")}
          confirmLabel={t("rules.removeLabel")}
          cancelLabel={tCommon("cancel")}
          pending={removing === rule.id}
          onConfirm={() => remove(rule)}
        >
          <Button
            isIconOnly
            size="sm"
            variant="danger-soft"
            aria-label={t("rules.remove", { name: rule.name })}
            isDisabled={removing !== null}
          >
            <Trash2 size={14} aria-hidden />
          </Button>
        </ConfirmDialog>
      </>
    );
  }

  const addButton = canManage ? (
    <Button onPress={() => open(null)} isDisabled={full}>
      <Plus size={16} aria-hidden />
      {t("rules.add")}
    </Button>
  ) : null;

  const dialogNode = canManage ? (
    <RuleDialog key={`rule-${editing.key}`} state={dialog} policy={policy} editing={editing.rule} onSaved={onSaved} />
  ) : null;

  if (rules.length === 0) {
    return (
      <>
        <EmptyState icon={ListChecks} title={t("rules.emptyTitle")} description={t("rules.emptyHint")} action={addButton} />
        {dialogNode}
      </>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted">{t("rules.hint")}</p>
        <div className="flex flex-wrap items-center gap-3">
          {full ? <span className="text-sm text-muted">{t("rules.full", { max: MAX_RULES })}</span> : null}
          {addButton}
        </div>
      </div>
      {rules.length >= SEARCH_FROM ? (
        <SearchField value={query} onChange={setQuery} aria-label={t("rules.search")} className="w-full sm:max-w-xs">
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder={t("rules.search")} />
            <SearchField.ClearButton aria-label={tCommon("close")} />
          </SearchField.Group>
        </SearchField>
      ) : null}
      {visible.length === 0 ? (
        <EmptyState icon={SearchX} title={t("rules.noMatches")} description={t("rules.noMatchesHint")} />
      ) : (
        <>
          <RowCards label={t("rules.title")}>
            {visible.map((rule) => (
              <RowCard
                key={rule.id}
                title={rule.name}
                description={summary(rule)}
                details={[
                  { label: t("rules.target"), value: t("rules.targetLabel", { target: rule.target }) },
                  {
                    label: t("rules.action"),
                    value: (
                      <Chip size="sm" variant="soft">
                        {t("actionLabel", { action: rule.action })}
                      </Chip>
                    ),
                  },
                ]}
                actions={actions(rule)}
              />
            ))}
          </RowCards>
          <Table aria-label={t("rules.title")} className={TABLE_FROM_LG}>
            <Table.ScrollContainer>
              <Table.Content aria-label={t("rules.title")}>
                <Table.Header>
                  <Table.Column isRowHeader>{t("rules.columnRule")}</Table.Column>
                  <Table.Column>{t("rules.target")}</Table.Column>
                  <Table.Column>{t("rules.action")}</Table.Column>
                  {canManage ? <Table.Column>{tCommon("actions")}</Table.Column> : null}
                </Table.Header>
                <Table.Body>
                  {visible.map((rule) => (
                    <Table.Row key={rule.id} id={rule.id}>
                      <Table.Cell>
                        <div className="min-w-0 space-y-0.5">
                          <p className="text-sm font-medium break-words text-foreground">{rule.name}</p>
                          <p className="text-xs break-words text-muted">{summary(rule)}</p>
                        </div>
                      </Table.Cell>
                      <Table.Cell>
                        <span className="text-sm whitespace-nowrap">{t("rules.targetLabel", { target: rule.target })}</span>
                      </Table.Cell>
                      <Table.Cell>
                        <Chip size="sm" variant="soft">
                          {t("actionLabel", { action: rule.action })}
                        </Chip>
                      </Table.Cell>
                      {canManage ? (
                        <Table.Cell>
                          <div className="flex items-center gap-1">{actions(rule)}</div>
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
      <p className="text-xs text-muted">{t("content.streamHint")}</p>
      {dialogNode}
    </div>
  );
}
