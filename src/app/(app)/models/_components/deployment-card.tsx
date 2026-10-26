"use client";

import { Button, Card, Input, Label, TextField } from "@heroui/react";
import { Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import type { DeploymentDraft, ProviderOpt } from "@/types/models";
import { catalogHit, contextWindowOf } from "./deployment-draft";
import ProviderSelect from "./provider-select";

export default function DeploymentCard({
  index,
  dep,
  withCatalog,
  showWeight,
  removable,
  providers,
  isDisabled,
  onChange,
  onRemove,
}: {
  index: number;
  dep: DeploymentDraft;
  withCatalog: boolean;
  showWeight: boolean;
  removable: boolean;
  providers: ProviderOpt[];
  isDisabled: boolean;
  onChange: (patch: Partial<DeploymentDraft>) => void;
  onRemove: () => void;
}) {
  const t = useTranslations("Models");
  const contextWindow = contextWindowOf(providers, dep.providerId, dep.model);
  const priced = catalogHit(providers, dep.providerId, dep.model);
  const providerName = providers.find((p) => p.id === dep.providerId)?.name ?? "";
  return (
    <Card variant="secondary" className="gap-3">
      <div className="grid gap-3 sm:grid-cols-2 sm:items-start">
        <ProviderSelect
          dep={dep}
          providers={providers}
          withCatalog={withCatalog}
          isDisabled={isDisabled}
          onChange={onChange}
        />
        <TextField fullWidth value={dep.model} onChange={(model) => onChange({ model })} isDisabled={isDisabled}>
          <Label>{t("fields.upstream")}</Label>
          <Input />
        </TextField>
      </div>
      {dep.providerId ? null : (
        <TextField fullWidth value={dep.baseUrl} onChange={(baseUrl) => onChange({ baseUrl })} isDisabled={isDisabled}>
          <Label>{t("fields.baseUrl")}</Label>
          <Input placeholder="https://" />
        </TextField>
      )}
      <div className={showWeight ? "grid gap-3 sm:grid-cols-3" : "grid gap-3 sm:grid-cols-2"}>
        {showWeight ? (
          <TextField fullWidth value={dep.weight} onChange={(weight) => onChange({ weight })} isDisabled={isDisabled}>
            <Label>{t("fields.weight")}</Label>
            <Input inputMode="numeric" />
          </TextField>
        ) : null}
        <TextField
          fullWidth
          value={dep.costInput}
          onChange={(costInput) => onChange({ costInput })}
          isDisabled={isDisabled}
        >
          <Label>{t("fields.costIn")}</Label>
          <Input inputMode="decimal" />
        </TextField>
        <TextField
          fullWidth
          value={dep.costOutput}
          onChange={(costOutput) => onChange({ costOutput })}
          isDisabled={isDisabled}
        >
          <Label>{t("fields.costOut")}</Label>
          <Input inputMode="decimal" />
        </TextField>
      </div>
      {dep.model.trim() || removable ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 text-xs text-muted">
            {dep.model.trim()
              ? [
                  priced ? t("priceFromProvider", { source: providerName }) : null,
                  t("contextHint", {
                    state: contextWindow ? (contextWindow.from === undefined ? "reported" : "borrowed") : "unknown",
                    tokens: contextWindow?.tokens ?? 0,
                    from: contextWindow?.from ?? "",
                  }),
                ]
                  .filter(Boolean)
                  .join(" · ")
              : null}
          </p>
          {removable ? (
            <Button
              size="sm"
              variant="danger-soft"
              isDisabled={isDisabled}
              aria-label={t("deleteEndpointAt", { index: index + 1 })}
              onPress={onRemove}
            >
              <Trash2 size={14} aria-hidden />
              {t("deleteEndpoint")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
