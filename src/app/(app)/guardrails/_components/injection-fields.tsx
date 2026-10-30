"use client";

import { Checkbox, CheckboxGroup, Description, Label, Switch } from "@heroui/react";
import { useTranslations } from "next-intl";
import { INJECTION_CHECKS } from "@/lib/gateway/safety/guardrails";
import type { InjectionAction, InjectionCheck, InjectionPolicy } from "@/types/guardrails";
import ChoiceCards from "@/components/console/choice-cards";

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
  const off = isDisabled || !value.enabled;

  return (
    <div className="space-y-5">
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
        <Description>{t("injection.enableHint")}</Description>
      </Switch>
      <ChoiceCards
        label={t("injection.action")}
        value={value.action}
        columns={2}
        options={INJECTION_ACTIONS.map((id) => ({
          id,
          label: t("actionLabel", { action: id }),
          hint: t("actionChoice", { context: "prompt", action: id }),
        }))}
        onChange={(action) => onChange({ ...value, action })}
        isDisabled={off}
      />
      <CheckboxGroup
        value={value.checks}
        onChange={(checks) => onChange({ ...value, checks: checks.filter(isInjectionCheck) })}
        isDisabled={off}
      >
        <Label>{t("injection.checks")}</Label>
        <div className="grid gap-3 sm:grid-cols-2">
          {INJECTION_CHECKS.map((check) => (
            <Checkbox key={check} value={check}>
              <Checkbox.Content>
                <Checkbox.Control>
                  <Checkbox.Indicator />
                </Checkbox.Control>
                <span className="min-w-0 space-y-0.5">
                  <Label>{t("injection.check", { check })}</Label>
                  <span className="block text-xs break-words text-muted">{t("injection.example", { check })}</span>
                </span>
              </Checkbox.Content>
            </Checkbox>
          ))}
        </div>
        <Description>{t("injection.checksHint")}</Description>
      </CheckboxGroup>
    </div>
  );
}
