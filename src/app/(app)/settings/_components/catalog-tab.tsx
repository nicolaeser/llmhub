"use client";

import { useState, useTransition, type ReactNode } from "react";
import {
  Button,
  Description,
  Disclosure,
  Input,
  Label,
  NumberField,
  Separator,
  TextField,
  toast,
} from "@heroui/react";
import { useTranslations } from "next-intl";
import ModelTestButton, { internalAliases, modelPickerItem } from "@/components/console/model-test";
import SearchSelect from "@/components/console/search-select";
import { SettingSection, SettingSwitch, SettingText } from "./setting-fields";
import { useErrorToast } from "@/components/console/use-error-toast";
import { formats } from "@/i18n/formats";
import { modelAlias } from "@/lib/gateway/catalog/model-alias";
import { DEFAULT_JEV_MODEL } from "@/lib/gateway/catalog/model-catalog";
import { choicesForRole, type ModelRole } from "@/lib/models/model-role";
import { Link } from "@/i18n/routing";
import { useActionData } from "@/lib/hooks/use-action-data";
import { isActionFail } from "@/lib/http/action-result";
import type { FeatureModelRole } from "@/types/models";
import type { CatalogSettings } from "@/types/settings";
import { loadCatalogSettingsAction, saveCatalogSettingsAction, testFeatureModelAction } from "../_action";
import SaveBar, { SettingsLead } from "./save-bar";
import TabState from "./tab-state";

export default function CatalogTab() {
  const t = useTranslations("Settings.catalog");
  const tSettings = useTranslations("Settings");
  const showError = useErrorToast();
  const [draft, setDraft] = useState<CatalogSettings | null>(null);
  const [pending, start] = useTransition();
  const page = useActionData(loadCatalogSettingsAction);
  const { data: view, setData } = page;

  if (!view) return <TabState state={page} />;

  const settings = draft ?? view.settings;
  const disabled = !view.canManage || pending;
  const update = (patch: Partial<CatalogSettings>) => setDraft({ ...settings, ...patch });
  const jev = (patch: Partial<CatalogSettings["catalog_jev"]>) =>
    update({ catalog_jev: { ...settings.catalog_jev, ...patch } });
  const vectors = (patch: Partial<CatalogSettings["vector_stores"]>) =>
    update({ vector_stores: { ...settings.vector_stores, ...patch } });
  const internal = internalAliases(view.models);
  const modelItems = (role: ModelRole, current: string) => [
    { id: "none", label: t("knowledge.none") },
    ...choicesForRole(view.models, role, current).map((model) => modelPickerItem(model, internal)),
  ];
  const pickModel = (key: string) => (key === "none" ? "" : key);
  const jevKeyReady = settings.catalog_jev.clear_api_key
    ? Boolean(settings.catalog_jev.api_key)
    : view.jevKeySet || Boolean(settings.catalog_jev.api_key);
  const jevModel = modelAlias(settings.catalog_jev.model || DEFAULT_JEV_MODEL);
  const jevAlias = view.models.some((model) => model.alias === jevModel);
  const jevReady = jevKeyReady || jevAlias;
  const jevRoute = jevKeyReady ? "key" : jevAlias ? "alias" : "none";
  const testModel = (feature: "catalog" | "knowledge", role: FeatureModelRole) => (model: string) =>
    testFeatureModelAction({ feature, role, model });
  const testButton = (role: FeatureModelRole, model: string) =>
    view.canManage ? <ModelTestButton model={model} isDisabled={!model} test={testModel("knowledge", role)} /> : null;
  const link = (href: string) => (chunks: ReactNode) => (
    <Link href={href} className="text-accent">
      {chunks}
    </Link>
  );

  function save() {
    start(async () => {
      const result = await saveCatalogSettingsAction(settings);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      setData(result);
      setDraft(null);
      toast(tSettings("saved"), { variant: "success" });
    });
  }

  return (
    <div className="space-y-8">
      <SettingsLead description={t("description")} canManage={view.canManage} />

      <SettingSection title={t("jev.title")} subtitle={t("jev.subtitle")}>
        <div className="flex flex-col gap-3">
          <SettingSwitch
            label={t("jev.autoRoutes")}
            isSelected={settings.catalog_auto_routes}
            onChange={(catalog_auto_routes) => update({ catalog_auto_routes })}
            isDisabled={disabled}
            hint={t("jev.autoRoutesHint")}
          />
        </div>
        <Separator />
        <SettingSwitch
          label={t("jev.enabled")}
          isSelected={settings.catalog_jev.enabled}
          onChange={(enabled) => jev({ enabled })}
          isDisabled={disabled || (!settings.catalog_jev.enabled && !jevReady)}
          hint={t("jev.enabledHint", { ready: jevReady ? "true" : "false" })}
        />
        {view.canManage ? (
          <>
            <TextField
              fullWidth
              type="password"
              value={settings.catalog_jev.api_key}
              onChange={(api_key) => jev({ api_key, clear_api_key: false })}
              isDisabled={disabled}
              className="max-w-xl"
            >
              <Label>{t("jev.apiKey")}</Label>
              <Input autoComplete="off" placeholder={t("jev.apiKeyState", { set: view.jevKeySet ? "true" : "false" })} />
              <Description>{t("jev.apiKeyHint")}</Description>
            </TextField>
            {view.jevKeySet ? (
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  size="sm"
                  variant={settings.catalog_jev.clear_api_key ? "secondary" : "danger-soft"}
                  isDisabled={disabled}
                  onPress={() =>
                    jev({
                      clear_api_key: !settings.catalog_jev.clear_api_key,
                      api_key: "",
                      enabled: settings.catalog_jev.clear_api_key ? settings.catalog_jev.enabled : false,
                    })
                  }
                >
                  {settings.catalog_jev.clear_api_key ? t("jev.keepKey") : t("jev.clearKey")}
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
        <Disclosure>
          <Disclosure.Heading>
            <Disclosure.Trigger className="flex w-full items-center justify-between gap-2 text-sm text-muted">
              {tSettings("advanced")}
              <Disclosure.Indicator />
            </Disclosure.Trigger>
          </Disclosure.Heading>
          <Disclosure.Content>
            <Disclosure.Body className="grid gap-4 pt-3 md:grid-cols-2 md:items-start">
              <NumberField
                fullWidth
                value={settings.catalog_min_confidence}
                onChange={(value) => update({ catalog_min_confidence: Number.isFinite(value) ? value : 0.9 })}
                minValue={0.5}
                maxValue={1}
                step={0.01}
                formatOptions={formats.number.percent}
                isDisabled={disabled}
              >
                <Label>{t("jev.minConfidence")}</Label>
                <NumberField.Group>
                  <NumberField.DecrementButton />
                  <NumberField.Input />
                  <NumberField.IncrementButton />
                </NumberField.Group>
                <Description>{t("jev.minConfidenceHint")}</Description>
              </NumberField>
              <div className="space-y-2">
                <SettingText
                  label={t("jev.model")}
                  value={settings.catalog_jev.model}
                  onChange={(model) => jev({ model })}
                  isDisabled={disabled}
                  placeholder={DEFAULT_JEV_MODEL}
                  hint={t("jev.modelHint", { route: jevRoute, model: jevModel })}
                />
                {view.canManage && jevRoute === "alias" ? (
                  <ModelTestButton model={jevModel} test={testModel("catalog", "jev")} />
                ) : null}
              </div>
            </Disclosure.Body>
          </Disclosure.Content>
        </Disclosure>
        <p className="text-xs text-muted">{t.rich("jev.catalogHint", { link: link("/model-catalog") })}</p>
      </SettingSection>

      <SettingSection title={t("knowledge.title")} subtitle={t("knowledge.subtitle")}>
        <div className="flex flex-col gap-3">
          <div className="grid min-w-0 flex-1 gap-4 md:grid-cols-2 md:items-start">
            <div className="space-y-2">
              <SearchSelect
                label={t("knowledge.embeddingModel")}
                description={t("knowledge.embeddingHint")}
                items={modelItems("embedding", settings.vector_stores.embedding_model)}
                value={settings.vector_stores.embedding_model || "none"}
                onChange={(key) => vectors({ embedding_model: pickModel(key) })}
                isDisabled={disabled}
              />
              {testButton("embedding", settings.vector_stores.embedding_model)}
            </div>
            <div className="space-y-2">
              <SearchSelect
                label={t("knowledge.ocrModel")}
                description={t("knowledge.ocrHint")}
                items={modelItems("ocr", settings.vector_stores.ocr_model)}
                value={settings.vector_stores.ocr_model || "none"}
                onChange={(key) => vectors({ ocr_model: pickModel(key) })}
                isDisabled={disabled}
              />
              {testButton("ocr", settings.vector_stores.ocr_model)}
            </div>
            <div className="space-y-2">
              <SearchSelect
                label={t("knowledge.rerankModel")}
                description={t("knowledge.rerankHint")}
                items={modelItems("rerank", settings.vector_stores.rerank_model)}
                value={settings.vector_stores.rerank_model || "none"}
                onChange={(key) => vectors({ rerank_model: pickModel(key) })}
                isDisabled={disabled}
              />
              {testButton("rerank", settings.vector_stores.rerank_model)}
            </div>
          </div>
        </div>
        <Disclosure>
          <Disclosure.Heading>
            <Disclosure.Trigger className="flex w-full items-center justify-between gap-2 text-sm text-muted">
              {tSettings("advanced")}
              <Disclosure.Indicator />
            </Disclosure.Trigger>
          </Disclosure.Heading>
          <Disclosure.Content>
            <Disclosure.Body className="pt-3">
              <NumberField
                fullWidth
                value={settings.vector_stores.embedding_dimensions}
                onChange={(value) => vectors({ embedding_dimensions: Number.isFinite(value) ? value : 0 })}
                minValue={0}
                maxValue={8192}
                formatOptions={formats.number.integer}
                isDisabled={disabled || !settings.vector_stores.embedding_model}
                className="max-w-sm"
              >
                <Label>{t("knowledge.dimensions")}</Label>
                <NumberField.Group>
                  <NumberField.DecrementButton />
                  <NumberField.Input />
                  <NumberField.IncrementButton />
                </NumberField.Group>
                <Description>{t("knowledge.dimensionsHint")}</Description>
              </NumberField>
            </Disclosure.Body>
          </Disclosure.Content>
        </Disclosure>
        <p className="text-xs text-muted">{t.rich("knowledge.manageHint", { link: link("/knowledge") })}</p>
      </SettingSection>
      <SaveBar canManage={view.canManage} pending={pending} onSave={save} />
    </div>
  );
}
