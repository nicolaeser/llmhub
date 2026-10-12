"use client";

import { Button, Card, Description, FieldError, Input, Label, Switch, TextArea, TextField } from "@heroui/react";
import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { GUARDRAIL_ACTIONS, MAX_RULES, RULE_KINDS, RULE_TARGETS, ruleIssue } from "@/lib/gateway/guardrails";
import type { GuardrailRule } from "@/types/guardrails";
import ChoiceSelect from "./choice-select";

function newRuleId(): string {
  return `rule_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export default function GuardrailRules({
  rules,
  onChange,
  isDisabled,
}: {
  rules: GuardrailRule[];
  onChange: (rules: GuardrailRule[]) => void;
  isDisabled?: boolean;
}) {
  const t = useTranslations("Guardrails");
  const kinds = RULE_KINDS.map((id) => ({ id, label: t("rules.kindLabel", { kind: id }) }));
  const targets = RULE_TARGETS.map((id) => ({ id, label: t("rules.targetLabel", { target: id }) }));
  const actions = GUARDRAIL_ACTIONS.map((id) => ({ id, label: t("actionLabel", { action: id }) }));

  function patch(id: string, change: Partial<GuardrailRule>) {
    onChange(rules.map((rule) => (rule.id === id ? { ...rule, ...change } : rule)));
  }

  function add() {
    onChange([
      ...rules,
      {
        id: newRuleId(),
        name: t("rules.defaultName", { n: rules.length + 1 }),
        kind: "denylist",
        target: "input",
        action: "block",
        patterns: [""],
        caseSensitive: false,
      },
    ]);
  }

  return (
    <section className="space-y-3" aria-label={t("rules.title")}>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{t("rules.title")}</h3>
        <p className="text-sm text-muted">{t("rules.hint")}</p>
      </div>
      {rules.length === 0 ? <p className="text-sm text-muted">{t("rules.empty")}</p> : null}
      {rules.map((rule) => {
        const issue = ruleIssue(rule, rules);
        const message = issue ? t("rules.issue", { issue: issue.issue, line: issue.line }) : "";
        return (
          <Card key={rule.id} variant="secondary" className="gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                fullWidth
                value={rule.name}
                onChange={(name) => patch(rule.id, { name })}
                isDisabled={isDisabled}
                isInvalid={issue?.field === "name"}
              >
                <Label>{t("rules.name")}</Label>
                <Input />
                {issue?.field === "name" ? <FieldError>{message}</FieldError> : null}
              </TextField>
              <ChoiceSelect
                label={t("rules.kind")}
                value={rule.kind}
                options={kinds}
                onChange={(kind) => patch(rule.id, { kind })}
                isDisabled={isDisabled}
              />
              <ChoiceSelect
                label={t("rules.target")}
                value={rule.target}
                options={targets}
                onChange={(target) => patch(rule.id, { target })}
                isDisabled={isDisabled}
              />
              <ChoiceSelect
                label={t("rules.action")}
                value={rule.action}
                options={actions}
                onChange={(action) => patch(rule.id, { action })}
                isDisabled={isDisabled}
              />
            </div>
            <TextField
              fullWidth
              value={rule.patterns.join("\n")}
              onChange={(value) => patch(rule.id, { patterns: value.split("\n") })}
              isDisabled={isDisabled}
              isInvalid={issue?.field === "patterns"}
            >
              <Label>{t("rules.patterns", { kind: rule.kind })}</Label>
              <TextArea rows={4} className="font-mono text-xs" />
              <Description>{t("rules.patternsHint", { kind: rule.kind })}</Description>
              {issue?.field === "patterns" ? <FieldError>{message}</FieldError> : null}
            </TextField>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Switch
                isSelected={rule.caseSensitive}
                onChange={(caseSensitive) => patch(rule.id, { caseSensitive })}
                isDisabled={isDisabled}
              >
                <Switch.Content>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                  <Label>{t("rules.caseSensitive")}</Label>
                </Switch.Content>
              </Switch>
              <Button
                size="sm"
                variant="danger-soft"
                isDisabled={isDisabled}
                onPress={() => onChange(rules.filter((other) => other.id !== rule.id))}
              >
                <Trash2 size={14} aria-hidden />
                {t("rules.remove", { name: rule.name })}
              </Button>
            </div>
          </Card>
        );
      })}
      <Button size="sm" variant="secondary" isDisabled={isDisabled || rules.length >= MAX_RULES} onPress={add}>
        <Plus size={14} aria-hidden />
        {t("rules.add")}
      </Button>
    </section>
  );
}
