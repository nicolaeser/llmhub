"use client";

import { Description, Label, ListBox, Select, Switch } from "@heroui/react";
import { useTranslations } from "next-intl";
import type { PiiPolicy } from "@/types/guardrails";

export default function PiiPolicyFields({
  value,
  onChange,
  isDisabled,
}: {
  value: PiiPolicy;
  onChange: (next: PiiPolicy) => void;
  isDisabled?: boolean;
}) {
  const t = useTranslations("Guardrails");

  return (
    <div className="grid gap-4 md:grid-cols-2 md:items-start">
      <div className="space-y-4">
        <Switch
          isSelected={value.enabled}
          onChange={(enabled) => onChange({ ...value, enabled })}
          isDisabled={isDisabled}
          aria-label={t("enable")}
        >
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            <Label>{t("enable")}</Label>
          </Switch.Content>
          <Description>{t("enableHint")}</Description>
        </Switch>
        <Select
          selectedKey={value.mode}
          onSelectionChange={(key) => onChange({ ...value, mode: key === "block" ? "block" : "mask" })}
          isDisabled={isDisabled}
          aria-label={t("mode")}
          fullWidth
        >
          <Label>{t("mode")}</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox aria-label={t("mode")}>
              <ListBox.Item id="mask" textValue={t("mask")}>
                {t("mask")}
                <ListBox.ItemIndicator />
              </ListBox.Item>
              <ListBox.Item id="block" textValue={t("block")}>
                {t("block")}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            </ListBox>
          </Select.Popover>
        </Select>
      </div>
      <div className="space-y-4">
        <Switch
          isSelected={value.output}
          onChange={(output) => onChange({ ...value, output })}
          isDisabled={isDisabled}
          aria-label={t("output")}
        >
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            <Label>{t("output")}</Label>
          </Switch.Content>
          <Description>{t("outputHint")}</Description>
        </Switch>
      </div>
    </div>
  );
}
