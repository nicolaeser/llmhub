"use client";

import { useState, useTransition } from "react";
import { Button, Description, Label, ListBox, Select, Spinner, toast } from "@heroui/react";
import { Save } from "lucide-react";
import { useTranslations } from "next-intl";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import type { SignInKind, WindowKickoffs } from "@/types/providers";
import { saveWindowKickoffAction } from "../_action";

const OFF_KEY = "kickoff:off";

export default function WindowKickoffSettings({
  kind,
  model,
  models,
  onSaved,
}: {
  kind: SignInKind;
  model: string;
  models: string[];
  onSaved: (kickoff: WindowKickoffs) => void;
}) {
  const t = useTranslations("Subscriptions.kickoff");
  const tProviders = useTranslations("Providers");
  const showError = useErrorToast();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, start] = useTransition();
  const selected = draft ?? model;
  const provider = tProviders("kindShort", { kind });
  const options = model && !models.includes(model) ? [model, ...models] : models;

  function save() {
    start(async () => {
      const result = await saveWindowKickoffAction({ kind, model: selected });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onSaved(result.kickoff);
      setDraft(null);
      toast(t("saved", { provider }), { variant: "success" });
    });
  }

  return (
    <div role="group" aria-label={t("label", { provider })} className="space-y-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">{t("title")}</p>
        <p className="text-xs text-muted">{t("description")}</p>
      </div>
      <Select
        fullWidth
        selectedKey={selected || OFF_KEY}
        onSelectionChange={(key) => setDraft(key === OFF_KEY || key === null ? "" : String(key))}
        isDisabled={saving}
      >
        <Label>{t("model")}</Label>
        <Select.Trigger>
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Description>{models.length ? t("modelHint", { provider }) : t("noModels", { provider })}</Description>
        <Select.Popover>
          <ListBox aria-label={t("model")}>
            <ListBox.Item key={OFF_KEY} id={OFF_KEY} textValue={t("off")}>
              {t("off")}
              <ListBox.ItemIndicator />
            </ListBox.Item>
            {options.map((item) => (
              <ListBox.Item key={item} id={item} textValue={item}>
                {item}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          size="sm"
          variant="secondary"
          isDisabled={draft === null || draft === model}
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
