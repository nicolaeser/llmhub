"use client";

import { Checkbox, CheckboxGroup, Description, Label, Switch } from "@heroui/react";
import { useTranslations } from "next-intl";
import { GUARDRAIL_ACTIONS, SECRET_ENTITIES } from "@/lib/gateway/safety/guardrails";
import type { SecretsPolicy } from "@/types/guardrails";
import ChoiceCards from "@/components/console/choice-cards";

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
          <Label>{t("secrets.enable")}</Label>
        </Switch.Content>
        <Description>{t("secrets.enableHint")}</Description>
      </Switch>
      <ChoiceCards
        label={t("secrets.action")}
        value={value.action}
        options={GUARDRAIL_ACTIONS.map((id) => ({
          id,
          label: t("actionLabel", { action: id }),
          hint: t("actionChoice", { context: "response", action: id }),
        }))}
        onChange={(action) => onChange({ ...value, action })}
        isDisabled={off}
      />
      <CheckboxGroup
        value={value.entities}
        onChange={(entities) => onChange({ ...value, entities })}
        isDisabled={off}
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
