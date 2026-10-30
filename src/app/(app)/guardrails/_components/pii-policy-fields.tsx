"use client";

import { Description, Label, Switch } from "@heroui/react";
import { useTranslations } from "next-intl";
import { PII_DETECTORS, PII_FAILURES } from "@/lib/gateway/safety/pii";
import type { PiiMode, PiiPolicy } from "@/types/guardrails";
import ChoiceCards from "@/components/console/choice-cards";
import ChoiceSelect from "./choice-select";

const PII_MODES: readonly PiiMode[] = ["mask", "block", "restore"];

type FieldProps = {
  value: PiiPolicy;
  onChange: (next: PiiPolicy) => void;
  isDisabled?: boolean;
};

export function PiiBehaviorFields({ value, onChange, isDisabled }: FieldProps) {
  const t = useTranslations("Guardrails");

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
          <Label>{t("enable")}</Label>
        </Switch.Content>
        <Description>{t("enableHint")}</Description>
      </Switch>
      <ChoiceCards
        label={t("mode")}
        value={value.mode}
        options={PII_MODES.map((id) => ({ id, label: t("modeOption", { mode: id }), hint: t("modeHint", { mode: id }) }))}
        onChange={(mode) => onChange({ ...value, mode })}
        description={t("modeNote")}
        isDisabled={isDisabled || !value.enabled}
      />
      <Switch
        isSelected={value.output}
        onChange={(output) => onChange({ ...value, output })}
        isDisabled={isDisabled || !value.enabled}
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
  );
}

export function PiiDetectionFields({ value, onChange, isDisabled }: FieldProps) {
  const t = useTranslations("Guardrails");

  return (
    <div className="grid gap-4 md:grid-cols-2 md:items-start">
      <ChoiceSelect
        label={t("detector")}
        value={value.detector}
        options={PII_DETECTORS.map((id) => ({ id, label: t("detectorOption", { detector: id }) }))}
        onChange={(detector) => onChange({ ...value, detector })}
        description={t("detectorHint", { detector: value.detector })}
        isDisabled={isDisabled}
      />
      {value.detector === "patterns" ? null : (
        <ChoiceSelect
          label={t("failure")}
          value={value.failure}
          options={PII_FAILURES.map((id) => ({ id, label: t("failureOption", { failure: id }) }))}
          onChange={(failure) => onChange({ ...value, failure })}
          description={t("failureHint")}
          isDisabled={isDisabled}
        />
      )}
    </div>
  );
}
