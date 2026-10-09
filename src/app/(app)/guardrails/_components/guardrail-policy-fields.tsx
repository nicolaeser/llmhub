"use client";

import { Checkbox, CheckboxGroup, Description, Label, Separator, Switch } from "@heroui/react";
import { useTranslations } from "next-intl";
import { GUARDRAIL_ACTIONS, INJECTION_CHECKS, SECRET_ENTITIES } from "@/lib/gateway/guardrails";
import type { GuardrailPolicy, InjectionAction, InjectionCheck } from "@/types/guardrails";
import ChoiceSelect from "./choice-select";
import GuardrailRules from "./guardrail-rules";

const INJECTION_ACTIONS: readonly InjectionAction[] = ["block", "flag"];

function isInjectionCheck(value: string): value is InjectionCheck {
  return INJECTION_CHECKS.some((check) => check === value);
}

export default function GuardrailPolicyFields({
  value,
  onChange,
  isDisabled,
}: {
  value: GuardrailPolicy;
  onChange: (next: GuardrailPolicy) => void;
  isDisabled?: boolean;
}) {
  const t = useTranslations("Guardrails");
  const { injection, secrets } = value;

  return (
    <div className="space-y-5">
      <section className="space-y-4" aria-label={t("injection.title")}>
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">{t("injection.title")}</h3>
          <p className="text-sm text-muted">{t("injection.hint")}</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2 md:items-start">
          <Switch
            isSelected={injection.enabled}
            onChange={(enabled) => onChange({ ...value, injection: { ...injection, enabled } })}
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
            value={injection.action}
            options={INJECTION_ACTIONS.map((id) => ({ id, label: t("actionLabel", { action: id }) }))}
            onChange={(action) => onChange({ ...value, injection: { ...injection, action } })}
            description={t("injection.actionHint")}
            isDisabled={isDisabled || !injection.enabled}
          />
        </div>
        <CheckboxGroup
          value={injection.checks}
          onChange={(checks) =>
            onChange({ ...value, injection: { ...injection, checks: checks.filter(isInjectionCheck) } })
          }
          isDisabled={isDisabled || !injection.enabled}
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
      </section>
      <Separator />
      <section className="space-y-4" aria-label={t("secrets.title")}>
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">{t("secrets.title")}</h3>
          <p className="text-sm text-muted">{t("secrets.hint")}</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2 md:items-start">
          <Switch
            isSelected={secrets.enabled}
            onChange={(enabled) => onChange({ ...value, secrets: { ...secrets, enabled } })}
            isDisabled={isDisabled}
          >
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              <Label>{t("secrets.enable")}</Label>
            </Switch.Content>
          </Switch>
          <ChoiceSelect
            label={t("secrets.action")}
            value={secrets.action}
            options={GUARDRAIL_ACTIONS.map((id) => ({ id, label: t("actionLabel", { action: id }) }))}
            onChange={(action) => onChange({ ...value, secrets: { ...secrets, action } })}
            description={t("actionHint")}
            isDisabled={isDisabled || !secrets.enabled}
          />
        </div>
        <CheckboxGroup
          value={secrets.entities}
          onChange={(entities) => onChange({ ...value, secrets: { ...secrets, entities } })}
          isDisabled={isDisabled || !secrets.enabled}
        >
          <Label>{t("secrets.entities")}</Label>
          <div className="grid gap-2 sm:grid-cols-2">
            {SECRET_ENTITIES.map((id) => (
              <Checkbox key={id} value={id}>
                <Checkbox.Content>
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  <Label>{t("entityLabel", { id })}</Label>
                </Checkbox.Content>
              </Checkbox>
            ))}
          </div>
          <Description>{t("secrets.entitiesHint")}</Description>
        </CheckboxGroup>
      </section>
      <Separator />
      <GuardrailRules
        rules={value.rules}
        onChange={(rules) => onChange({ ...value, rules })}
        isDisabled={isDisabled}
      />
    </div>
  );
}
