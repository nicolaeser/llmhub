"use client";

import { useState, useTransition } from "react";
import {
  Button,
  Description,
  FieldError,
  Label,
  ListBox,
  NumberField,
  Select,
  Spinner,
  Switch,
  toast,
} from "@heroui/react";
import { Save } from "lucide-react";
import { useTranslations } from "next-intl";
import { useErrorToast } from "@/components/console/use-error-toast";
import { formats } from "@/i18n/formats";
import { isActionFail } from "@/lib/http/action-result";
import { AUTO_RESET_PERCENT_MAX, AUTO_RESET_PERCENT_MIN, AUTO_RESET_SCOPES } from "@/schemas/resets";
import type { AutoResetPolicies, AutoResetPolicy, ResetKind } from "@/types/resets";
import { saveAutoResetAction } from "../_action";

type Draft = Omit<AutoResetPolicy, "percent"> & { percent: number | null };

function validPercent(value: number | null): value is number {
  return value !== null && Number.isInteger(value) && value >= AUTO_RESET_PERCENT_MIN && value <= AUTO_RESET_PERCENT_MAX;
}

export default function AutoResetSettings({
  kind,
  policy,
  onSaved,
}: {
  kind: ResetKind;
  policy: AutoResetPolicy;
  onSaved: (policies: AutoResetPolicies) => void;
}) {
  const t = useTranslations("Subscriptions.resets.auto");
  const tProviders = useTranslations("Providers");
  const showError = useErrorToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, start] = useTransition();
  const { enabled, percent, scope }: Draft = draft ?? policy;
  const provider = tProviders("kindName", { kind });
  const changed =
    draft !== null && (draft.enabled !== policy.enabled || draft.percent !== policy.percent || draft.scope !== policy.scope);
  const valid = validPercent(percent);
  const locked = saving;

  function update(patch: Partial<Draft>) {
    setDraft({ enabled, percent, scope, ...patch });
  }

  function save() {
    if (!validPercent(percent)) return;
    start(async () => {
      const result = await saveAutoResetAction({ kind, enabled, percent, scope });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onSaved(result.autoReset);
      setDraft(null);
      toast(t("saved", { provider }), { variant: "success" });
    });
  }

  return (
    <div role="group" aria-label={t("label", { provider })} className="space-y-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">
          {t("title")}
        </p>
        <p className="text-xs text-muted">{t("description")}</p>
      </div>
      <Switch isSelected={enabled} onChange={(next) => update({ enabled: next })} isDisabled={locked}>
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          <Label>{t("enabled")}</Label>
        </Switch.Content>
      </Switch>
      <div className="grid gap-4 sm:grid-cols-2">
        <NumberField
          fullWidth
          value={percent ?? Number.NaN}
          onChange={(value) => update({ percent: Number.isFinite(value) ? Math.round(value) : null })}
          minValue={AUTO_RESET_PERCENT_MIN}
          maxValue={AUTO_RESET_PERCENT_MAX}
          step={1}
          formatOptions={formats.number.percentPoints}
          isDisabled={locked}
          isInvalid={!valid}
        >
          <Label>{t("threshold")}</Label>
          <NumberField.Group>
            <NumberField.DecrementButton />
            <NumberField.Input />
            <NumberField.IncrementButton />
          </NumberField.Group>
          <Description>{t("thresholdHint", { min: AUTO_RESET_PERCENT_MIN / 100, max: AUTO_RESET_PERCENT_MAX / 100 })}</Description>
          <FieldError>{t("thresholdInvalid", { min: AUTO_RESET_PERCENT_MIN / 100, max: AUTO_RESET_PERCENT_MAX / 100 })}</FieldError>
        </NumberField>
        <Select
          fullWidth
          selectedKey={scope}
          onSelectionChange={(key) => {
            const next = AUTO_RESET_SCOPES.find((item) => item === key);
            if (next) update({ scope: next });
          }}
          isDisabled={locked}
        >
          <Label>{t("scope")}</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Description>{t("scopeHint", { scope })}</Description>
          <Select.Popover>
            <ListBox aria-label={t("scope")}>
              {AUTO_RESET_SCOPES.map((item) => (
                <ListBox.Item key={item} id={item} textValue={t("scopeOption", { scope: item })}>
                  {t("scopeOption", { scope: item })}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      </div>
      {kind === "claude" ? <p className="text-xs text-muted">{t("claudeNote")}</p> : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          size="sm"
          variant="secondary"
          isDisabled={!changed || !valid}
          isPending={saving}
          aria-label={t("save", { provider })}
          onPress={save}
        >
          {({ isPending }) => (
            <>
              {isPending ? <Spinner color="current" size="sm" /> : <Save size={14} aria-hidden />}
              {t("saveShort")}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
