"use client";

import { useState, useTransition } from "react";
import { Chip, Description, Label, NumberField, toast } from "@heroui/react";
import { useTranslations } from "next-intl";
import { formats } from "@/i18n/formats";
import SearchSelect from "@/components/console/search-select";
import { choicesForRole } from "@/lib/models/model-role";
import { SettingSection, SettingSwitch } from "./setting-fields";
import { useErrorToast } from "@/components/console/use-error-toast";
import { loadCacheAction, saveCacheAction } from "../_action";
import {
  CACHE_TTL_MAX_SECONDS,
  SEMANTIC_THRESHOLD_DEFAULT,
  SEMANTIC_THRESHOLD_MIN,
} from "@/lib/gateway/cache/cache-settings";
import { useActionData } from "@/lib/hooks/use-action-data";
import { isActionFail } from "@/lib/http/action-result";
import CacheStats from "./cache-stats";
import SaveBar, { SettingsLead } from "./save-bar";
import TabState from "./tab-state";
import type { SemanticCacheSettings } from "@/types/cache";

const BACKEND_COLOR = { redis: "success", memory: "default", fallback: "warning" } as const;

export default function CacheTab() {
  const t = useTranslations("Settings.cache");
  const tSettings = useTranslations("Settings");
  const showError = useErrorToast();
  const [ttlDraft, setTtl] = useState<number | null>(null);
  const [semanticDraft, setSemantic] = useState<SemanticCacheSettings | null>(null);
  const [pending, start] = useTransition();
  const page = useActionData(loadCacheAction);
  const { data: view, setData: setView } = page;

  if (!view) return <TabState state={page} />;

  const ttl = ttlDraft ?? view.cacheTtlSeconds;
  const semantic = semanticDraft ?? view.semantic;
  const disabled = !view.canManage;
  const update = (patch: Partial<SemanticCacheSettings>) => setSemantic({ ...semantic, ...patch });

  return (
    <div className="space-y-5">
      <SettingsLead description={t("description")} canManage={view.canManage} />
      {view.stats ? <CacheStats initial={view.stats} semanticOn={view.semantic.enabled} /> : null}
      <SettingSection title={t("store.title")} subtitle={t("store.description")}>
        <div className="flex flex-wrap items-center gap-2">
          <Chip size="sm" variant="soft" color={BACKEND_COLOR[view.backend]}>
            {t("store.backend", { backend: view.backend })}
          </Chip>
          <p className="text-xs text-muted">{t("store.backendHint", { backend: view.backend })}</p>
        </div>
        <NumberField
          fullWidth
          value={ttl}
          onChange={(value) => setTtl(Number.isFinite(value) ? value : 0)}
          minValue={0}
          maxValue={CACHE_TTL_MAX_SECONDS}
          step={1}
          formatOptions={formats.number.integer}
          isDisabled={disabled}
          className="max-w-md"
        >
          <Label>{t("ttl")}</Label>
          <NumberField.Group>
            <NumberField.DecrementButton />
            <NumberField.Input />
            <NumberField.IncrementButton />
          </NumberField.Group>
          <Description>{t("ttlHint")}</Description>
        </NumberField>
      </SettingSection>
      <SettingSection title={t("semantic.title")} subtitle={t("semantic.description")}>
        <SettingSwitch
          label={t("semantic.enabled")}
          isSelected={semantic.enabled}
          onChange={(enabled) => update({ enabled })}
          isDisabled={disabled || (!semantic.enabled && !semantic.model)}
          hint={t("semantic.enabledHint", { ready: semantic.model ? "true" : "false" })}
        />
        <SearchSelect
          label={t("semantic.model")}
          description={t("semantic.modelHint")}
          items={[
            { id: "none", label: t("semantic.none") },
            ...choicesForRole(view.models, "embedding", semantic.model).map((model) => ({
              id: model.alias,
              label: model.label,
              detail: model.label === model.alias ? undefined : model.alias,
            })),
          ]}
          value={semantic.model || "none"}
          onChange={(key) => {
            const model = key === "none" ? "" : key;
            update({ model, enabled: model ? semantic.enabled : false });
          }}
          isDisabled={disabled}
          className="max-w-md"
        />
        <NumberField
          fullWidth
          value={semantic.threshold}
          onChange={(threshold) => update({ threshold: Number.isFinite(threshold) ? threshold : SEMANTIC_THRESHOLD_DEFAULT })}
          minValue={SEMANTIC_THRESHOLD_MIN}
          maxValue={1}
          step={0.01}
          formatOptions={formats.number.percent}
          isDisabled={disabled}
          className="max-w-xs"
        >
          <Label>{t("semantic.threshold")}</Label>
          <NumberField.Group>
            <NumberField.DecrementButton />
            <NumberField.Input />
            <NumberField.IncrementButton />
          </NumberField.Group>
          <Description>{t("semantic.thresholdHint")}</Description>
        </NumberField>
      </SettingSection>
      <SaveBar
        canManage={view.canManage}
        pending={pending}
        onSave={() =>
          start(async () => {
            const result = await saveCacheAction({ cacheTtlSeconds: ttl, semantic });
            if (isActionFail(result)) {
              showError(result.error);
              return;
            }
            setView(result);
            setTtl(null);
            setSemantic(null);
            toast(tSettings("saved"), { variant: "success" });
          })
        }
      />
    </div>
  );
}
