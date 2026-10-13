"use client";

import { useTransition } from "react";
import { Label, Switch } from "@heroui/react";
import { useTranslations } from "next-intl";
import { updateProviderAction } from "../_action";
import { isActionFail } from "@/lib/http/action-result";
import type { ProviderView } from "@/types/providers";
import { useErrorToast } from "@/components/console/use-error-toast";

export default function ProviderToggle({
  row,
  onChanged,
  showLabel = true,
}: {
  row: ProviderView;
  onChanged: (provider: ProviderView) => void;
  showLabel?: boolean;
}) {
  const t = useTranslations("Providers");
  const showError = useErrorToast();
  const [pending, start] = useTransition();

  function change(enabled: boolean) {
    start(async () => {
      const result = await updateProviderAction({ id: row.id, name: "", baseUrl: "", apiKey: "", enabled });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onChanged(result.provider);
    });
  }

  return (
    <Switch
      size="sm"
      isSelected={row.enabled}
      onChange={change}
      isDisabled={pending}
      aria-label={t("enabled.toggle", { name: row.name })}
    >
      <Switch.Content>
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
        {showLabel ? <Label>{t("enabled.state", { enabled: String(row.enabled) })}</Label> : null}
      </Switch.Content>
    </Switch>
  );
}
