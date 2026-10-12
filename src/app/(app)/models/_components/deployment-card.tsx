"use client";

import { Button, Card, Input, Label, TextField } from "@heroui/react";
import { useTranslations } from "next-intl";
import type { DeploymentDraft, ProviderOpt } from "@/types/models";
import { catalogHit } from "./deployment-draft";
import ProviderSelect from "./provider-select";

export default function DeploymentCard({
  dep,
  primary,
  providers,
  isDisabled,
  onChange,
  onRemove,
}: {
  dep: DeploymentDraft;
  primary: boolean;
  providers: ProviderOpt[];
  isDisabled: boolean;
  onChange: (patch: Partial<DeploymentDraft>) => void;
  onRemove: () => void;
}) {
  const t = useTranslations("Models");
  return (
    <Card variant="secondary">
      {primary ? null : (
        <>
          <ProviderSelect
            dep={dep}
            providers={providers}
            withCatalog={false}
            isDisabled={isDisabled}
            onChange={onChange}
          />
          <TextField
            fullWidth
            value={dep.model}
            onChange={(model) => onChange({ model })}
            isDisabled={isDisabled}
            aria-label={t("fields.upstream")}
          >
            <Label>{t("fields.upstream")}</Label>
            <Input aria-label={t("fields.upstream")} />
          </TextField>
        </>
      )}
      <TextField
        fullWidth
        value={dep.weight}
        onChange={(weight) => onChange({ weight })}
        isDisabled={isDisabled}
        aria-label={t("fields.weight")}
      >
        <Label>{t("fields.weight")}</Label>
        <Input aria-label={t("fields.weight")} />
      </TextField>
      <div className="grid grid-cols-2 gap-3">
        <TextField
          fullWidth
          value={dep.costInput}
          onChange={(costInput) => onChange({ costInput })}
          isDisabled={isDisabled}
          aria-label={t("fields.costIn")}
        >
          <Label>{t("fields.costIn")}</Label>
          <Input aria-label={t("fields.costIn")} />
        </TextField>
        <TextField
          fullWidth
          value={dep.costOutput}
          onChange={(costOutput) => onChange({ costOutput })}
          isDisabled={isDisabled}
          aria-label={t("fields.costOut")}
        >
          <Label>{t("fields.costOut")}</Label>
          <Input aria-label={t("fields.costOut")} />
        </TextField>
      </div>
      {catalogHit(providers, dep.providerId, dep.model) ? (
        <p className="text-sm text-muted">
          {t("priceFromProvider", {
            source: providers.find((p) => p.id === dep.providerId)?.name ?? "",
          })}
        </p>
      ) : null}
      {primary ? null : (
        <Button
          size="sm"
          variant="danger-soft"
          aria-label={t("deleteEndpoint")}
          isDisabled={isDisabled}
          onPress={onRemove}
        >
          {t("deleteEndpoint")}
        </Button>
      )}
    </Card>
  );
}
