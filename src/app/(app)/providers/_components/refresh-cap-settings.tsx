"use client";

import { useState, useTransition } from "react";
import { Button, Description, FieldError, Label, NumberField, Spinner, toast } from "@heroui/react";
import { Save } from "lucide-react";
import { useTranslations } from "next-intl";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import { REFRESH_CAP_MAX } from "@/schemas/providers";
import type { RefreshCaps, SignInKind } from "@/types/providers";
import { saveRefreshCapAction } from "../_action";

function validCap(value: number | null): value is number {
  return value !== null && Number.isInteger(value) && value >= 0 && value <= REFRESH_CAP_MAX;
}

export default function RefreshCapSettings({
  kind,
  cap,
  onSaved,
}: {
  kind: SignInKind;
  cap: number;
  onSaved: (caps: RefreshCaps) => void;
}) {
  const t = useTranslations("Subscriptions.refreshCap");
  const tProviders = useTranslations("Providers");
  const showError = useErrorToast();
  const [draft, setDraft] = useState<{ cap: number | null } | null>(null);
  const [saving, start] = useTransition();
  const value = draft ? draft.cap : cap;
  const valid = validCap(value);
  const provider = tProviders("kindShort", { kind });

  function save() {
    if (!validCap(value)) return;
    start(async () => {
      const result = await saveRefreshCapAction({ kind, cap: value });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onSaved(result.refreshCaps);
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
        onChange={(next) => setDraft({ cap: Number.isFinite(next) ? Math.round(next) : null })}
        minValue={0}
        maxValue={REFRESH_CAP_MAX}
        step={1}
        isDisabled={saving}
        isInvalid={!valid}
      >
        <Label>{t("cap")}</Label>
        <NumberField.Group>
          <NumberField.DecrementButton />
          <NumberField.Input />
          <NumberField.IncrementButton />
        </NumberField.Group>
        <Description>{t("capHint", { max: REFRESH_CAP_MAX })}</Description>
        <FieldError>{t("capInvalid", { max: REFRESH_CAP_MAX })}</FieldError>
      </NumberField>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          size="sm"
          variant="secondary"
          isDisabled={draft === null || value === cap || !valid}
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
