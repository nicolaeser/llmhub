"use client";

import { useState } from "react";
import { Description, FieldError, Input, Label, Switch, TextArea, TextField } from "@heroui/react";
import { useTranslations } from "next-intl";
import { GUARDRAIL_ACTIONS, RULE_KINDS, RULE_TARGETS, ruleIssue } from "@/lib/gateway/safety/guardrails";
import type { GuardrailRule } from "@/types/guardrails";
import ChoiceCards from "@/components/console/choice-cards";
import ChoiceSelect from "./choice-select";
import { upsertRule } from "./rule-view";

const CONTEXT = { input: "prompt", output: "response", both: "both" } as const;

export default function RuleFields({
  rule,
  rules,
  onChange,
  isDisabled,
}: {
  rule: GuardrailRule;
  rules: readonly GuardrailRule[];
  onChange: (next: GuardrailRule) => void;
  isDisabled?: boolean;
}) {
  const t = useTranslations("Guardrails");
  const [touched, setTouched] = useState(false);
  const issue = ruleIssue(rule, upsertRule(rules, rule));
  const shown = issue && (issue.issue !== "empty" || touched) ? issue : null;
  const message = shown ? t("rules.issue", { issue: shown.issue, line: shown.line }) : "";

  return (
    <div className="space-y-5">
      <TextField
        fullWidth
        isRequired
        value={rule.name}
        onChange={(name) => {
          setTouched(true);
          onChange({ ...rule, name });
        }}
        isDisabled={isDisabled}
        isInvalid={shown?.field === "name"}
      >
        <Label>{t("rules.name")}</Label>
        <Input />
        <Description>{t("rules.nameHint")}</Description>
        {shown?.field === "name" ? <FieldError>{message}</FieldError> : null}
      </TextField>
      <div className="grid gap-4 sm:grid-cols-2 sm:items-start">
        <ChoiceSelect
          label={t("rules.kind")}
          value={rule.kind}
          options={RULE_KINDS.map((id) => ({ id, label: t("rules.kindLabel", { kind: id }) }))}
          onChange={(kind) => onChange({ ...rule, kind })}
          isDisabled={isDisabled}
        />
        <ChoiceSelect
          label={t("rules.target")}
          value={rule.target}
          options={RULE_TARGETS.map((id) => ({ id, label: t("rules.targetLabel", { target: id }) }))}
          onChange={(target) => onChange({ ...rule, target })}
          isDisabled={isDisabled}
        />
      </div>
      <TextField
        fullWidth
        isRequired
        value={rule.patterns.join("\n")}
        onChange={(value) => {
          setTouched(true);
          onChange({ ...rule, patterns: value.split("\n") });
        }}
        isDisabled={isDisabled}
        isInvalid={shown?.field === "patterns"}
      >
        <Label>{t("rules.patterns", { kind: rule.kind })}</Label>
        <TextArea rows={4} className="font-mono text-xs" placeholder={t("rules.patternsPlaceholder", { kind: rule.kind })} />
        <Description>{t("rules.patternsHint", { kind: rule.kind })}</Description>
        {shown?.field === "patterns" ? <FieldError>{message}</FieldError> : null}
      </TextField>
      <ChoiceCards
        label={t("rules.action")}
        value={rule.action}
        options={GUARDRAIL_ACTIONS.map((id) => ({
          id,
          label: t("actionLabel", { action: id }),
          hint: t("actionChoice", { context: CONTEXT[rule.target], action: id }),
        }))}
        onChange={(action) => onChange({ ...rule, action })}
        isDisabled={isDisabled}
      />
      <Switch
        isSelected={rule.caseSensitive}
        onChange={(caseSensitive) => onChange({ ...rule, caseSensitive })}
        isDisabled={isDisabled}
      >
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          <Label>{t("rules.caseSensitive")}</Label>
        </Switch.Content>
        <Description>{t("rules.caseSensitiveHint")}</Description>
      </Switch>
    </div>
  );
}
