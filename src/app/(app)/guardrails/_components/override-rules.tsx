"use client";

import { Fragment, useState } from "react";
import { Button, Card, Separator } from "@heroui/react";
import { ArrowLeft, Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { MAX_RULES, ruleIssue } from "@/lib/gateway/safety/guardrails";
import type { GuardrailRule } from "@/types/guardrails";
import RuleFields from "./rule-fields";
import { useRuleSummary } from "./rule-summary";
import { newRule, nextRuleName, upsertRule, withoutRule } from "./rule-view";

export default function OverrideRules({
  rules,
  onChange,
  isDisabled,
}: {
  rules: GuardrailRule[];
  onChange: (rules: GuardrailRule[]) => void;
  isDisabled?: boolean;
}) {
  const t = useTranslations("Guardrails");
  const summary = useRuleSummary();
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = rules.find((rule) => rule.id === editingId) ?? null;

  function add() {
    const rule = newRule(nextRuleName(rules, (n) => t("rules.defaultName", { n })));
    onChange([...rules, rule]);
    setEditingId(rule.id);
  }

  if (editing) {
    const invalid = Boolean(ruleIssue(editing, rules));
    return (
      <div className="space-y-5">
        <Button size="sm" variant="tertiary" onPress={() => setEditingId(null)} isDisabled={invalid || isDisabled}>
          <ArrowLeft size={14} aria-hidden />
          {t("dialog.backToRules")}
        </Button>
        <RuleFields
          rule={editing}
          rules={rules}
          onChange={(next) => onChange(upsertRule(rules, next))}
          isDisabled={isDisabled}
        />
        <Button
          size="sm"
          variant="danger-soft"
          isDisabled={isDisabled}
          onPress={() => {
            onChange(withoutRule(rules, editing.id));
            setEditingId(null);
          }}
        >
          <Trash2 size={14} aria-hidden />
          {t("rules.remove", { name: editing.name })}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {rules.length ? (
        <Card variant="secondary" className="gap-0">
          {rules.map((rule, index) => (
            <Fragment key={rule.id}>
              {index > 0 ? <Separator /> : null}
              <div className="flex items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                <div className="min-w-0 space-y-0.5">
                  <p className="text-sm font-medium break-words text-foreground">{rule.name}</p>
                  <p className="text-xs break-words text-muted">{summary(rule)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    isIconOnly
                    size="sm"
                    variant="tertiary"
                    aria-label={t("rules.editFor", { name: rule.name })}
                    isDisabled={isDisabled}
                    onPress={() => setEditingId(rule.id)}
                  >
                    <Pencil size={14} aria-hidden />
                  </Button>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="danger-soft"
                    aria-label={t("rules.remove", { name: rule.name })}
                    isDisabled={isDisabled}
                    onPress={() => onChange(withoutRule(rules, rule.id))}
                  >
                    <Trash2 size={14} aria-hidden />
                  </Button>
                </div>
              </div>
            </Fragment>
          ))}
        </Card>
      ) : (
        <p className="text-sm text-muted">{t("dialog.noRules")}</p>
      )}
      <Button size="sm" variant="secondary" isDisabled={isDisabled || rules.length >= MAX_RULES} onPress={add}>
        <Plus size={14} aria-hidden />
        {t("rules.add")}
      </Button>
    </div>
  );
}
