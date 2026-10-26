"use client";

import { Checkbox, CheckboxGroup, Description, Label, Switch } from "@heroui/react";
import { useTranslations } from "next-intl";
import { GUARDRAIL_ACTIONS, SECRET_ENTITIES } from "@/lib/gateway/safety/guardrails";
import type { SecretsPolicy } from "@/types/guardrails";
import ChoiceSelect from "./choice-select";

export default function SecretsFields({
  value,
  onChange,
  isDisabled,
}: {
  value: SecretsPolicy;
  onChange: (next: SecretsPolicy) => void;
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
            <Label>{t("secrets.enable")}</Label>
          </Switch.Content>
        </Switch>
        <ChoiceSelect
          label={t("secrets.action")}
          value={value.action}
          options={GUARDRAIL_ACTIONS.map((id) => ({ id, label: t("actionLabel", { action: id }) }))}
          onChange={(action) => onChange({ ...value, action })}
          description={t("actionHint")}
          isDisabled={isDisabled || !value.enabled}
        />
      </div>
      <CheckboxGroup
        value={value.entities}
        onChange={(entities) => onChange({ ...value, entities })}
        isDisabled={isDisabled || !value.enabled}
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
    </div>
  );
}
