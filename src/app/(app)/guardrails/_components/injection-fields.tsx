"use client";

import { Checkbox, CheckboxGroup, Description, Label, Switch } from "@heroui/react";
import { useTranslations } from "next-intl";
import { INJECTION_CHECKS } from "@/lib/gateway/safety/guardrails";
import type { InjectionAction, InjectionCheck, InjectionPolicy } from "@/types/guardrails";
import ChoiceSelect from "./choice-select";

const INJECTION_ACTIONS: readonly InjectionAction[] = ["block", "flag"];

function isInjectionCheck(value: string): value is InjectionCheck {
  return INJECTION_CHECKS.some((check) => check === value);
}

export default function InjectionFields({
  value,
  onChange,
  isDisabled,
}: {
  value: InjectionPolicy;
  onChange: (next: InjectionPolicy) => void;
  isDisabled?: boolean;
}) {
  const t = useTranslations("Guardrails");

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2 md:items-start">
        <Switch
          isSelected={value.enabled}
          onChange={(enabled) => onChange({ ...value, enabled })}
          isDisabled={isDisabled}
        >
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            <Label>{t("injection.enable")}</Label>
          </Switch.Content>
        </Switch>
        <ChoiceSelect
          label={t("injection.action")}
          value={value.action}
          options={INJECTION_ACTIONS.map((id) => ({ id, label: t("actionLabel", { action: id }) }))}
          onChange={(action) => onChange({ ...value, action })}
          description={t("injection.actionHint")}
          isDisabled={isDisabled || !value.enabled}
        />
      </div>
      <CheckboxGroup
        value={value.checks}
        onChange={(checks) => onChange({ ...value, checks: checks.filter(isInjectionCheck) })}
        isDisabled={isDisabled || !value.enabled}
      >
        <Label>{t("injection.checks")}</Label>
        <div className="grid gap-2 sm:grid-cols-2">
          {INJECTION_CHECKS.map((check) => (
            <Checkbox key={check} value={check}>
              <Checkbox.Content>
                <Checkbox.Control>
                  <Checkbox.Indicator />
                </Checkbox.Control>
                <Label>
                  {t("injection.check", { check })}
                  <span className="ml-2 text-xs text-muted">{t("injection.example", { check })}</span>
                </Label>
              </Checkbox.Content>
            </Checkbox>
          ))}
        </div>
        <Description>{t("injection.checksHint")}</Description>
      </CheckboxGroup>
    </div>
  );
}
