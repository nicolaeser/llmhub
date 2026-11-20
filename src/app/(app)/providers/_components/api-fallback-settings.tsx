"use client";

import { useTransition } from "react";
import { Description, Label, Switch, toast } from "@heroui/react";
import { useTranslations } from "next-intl";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import type { ApiFallbacks, SignInKind } from "@/types/providers";
import { saveApiFallbackAction } from "../_action";

export default function ApiFallbackSettings({
  kind,
  enabled,
  onSaved,
}: {
  kind: SignInKind;
  enabled: boolean;
  onSaved: (fallback: ApiFallbacks) => void;
}) {
  const t = useTranslations("Subscriptions.apiFallback");
  const tProviders = useTranslations("Providers");
  const showError = useErrorToast();
  const [saving, start] = useTransition();
  const provider = tProviders("kindShort", { kind });

  function save(next: boolean) {
    start(async () => {
      const result = await saveApiFallbackAction({ kind, enabled: next });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onSaved(result.apiFallback);
      toast(t(next ? "on" : "off", { provider }), { variant: "success" });
    });
  }

  return (
    <div role="group" aria-label={t("label", { provider })} className="space-y-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">{t("title")}</p>
        <p className="text-xs text-muted">{t("description", { provider })}</p>
      </div>
      <Switch isSelected={enabled} onChange={save} isDisabled={saving}>
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          <Label>{t("enabled")}</Label>
        </Switch.Content>
        <Description>{t("hint")}</Description>
      </Switch>
    </div>
  );
}
