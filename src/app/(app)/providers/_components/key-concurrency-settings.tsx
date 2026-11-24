"use client";

import { useState, useTransition } from "react";
import { Button, Description, FieldError, Label, NumberField, Spinner, toast } from "@heroui/react";
import { Save } from "lucide-react";
import { useTranslations } from "next-intl";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import { KEY_CONCURRENCY_MAX } from "@/schemas/providers";
import type { KeyConcurrencyLimits, SignInKind } from "@/types/providers";
import { saveKeyConcurrencyAction } from "../_action";

function validLimit(value: number | null): value is number {
  return value !== null && Number.isInteger(value) && value >= 0 && value <= KEY_CONCURRENCY_MAX;
}

export default function KeyConcurrencySettings({
  kind,
  limit,
  onSaved,
}: {
  kind: SignInKind;
  limit: number;
  onSaved: (limits: KeyConcurrencyLimits) => void;
}) {
  const t = useTranslations("Subscriptions.keyConcurrency");
  const tProviders = useTranslations("Providers");
  const showError = useErrorToast();
  const [draft, setDraft] = useState<{ limit: number | null } | null>(null);
  const [saving, start] = useTransition();
  const value = draft ? draft.limit : limit;
  const valid = validLimit(value);
  const provider = tProviders("kindShort", { kind });

  function save() {
    if (!validLimit(value)) return;
    start(async () => {
      const result = await saveKeyConcurrencyAction({ kind, limit: value });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onSaved(result.keyConcurrency);
      setDraft(null);
      toast(t("saved", { provider }), { variant: "success" });
    });
  }

  return (
    <div role="group" aria-label={t("label", { provider })} className="space-y-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">{t("title")}</p>
        <p className="text-xs text-muted">{t("description", { provider })}</p>
      </div>
      <NumberField
        fullWidth
        value={value ?? Number.NaN}
        onChange={(next) => setDraft({ limit: Number.isFinite(next) ? Math.round(next) : null })}
        minValue={0}
        maxValue={KEY_CONCURRENCY_MAX}
        step={1}
        isDisabled={saving}
        isInvalid={!valid}
      >
        <Label>{t("limit")}</Label>
        <NumberField.Group>
          <NumberField.DecrementButton />
          <NumberField.Input />
          <NumberField.IncrementButton />
        </NumberField.Group>
        <Description>{t("limitHint", { max: KEY_CONCURRENCY_MAX })}</Description>
        <FieldError>{t("limitInvalid", { max: KEY_CONCURRENCY_MAX })}</FieldError>
      </NumberField>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          size="sm"
          variant="secondary"
          isDisabled={draft === null || value === limit || !valid}
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
