"use client";

import { useState, useTransition } from "react";
import { Alert, Button, Chip, Disclosure, Spinner, toast } from "@heroui/react";
import { HardDrive, KeySquare } from "lucide-react";
import { useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
import { SettingSection, SettingText } from "./setting-fields";
import { useErrorToast } from "@/components/console/use-error-toast";
import { hasPlaceholder, presetEndpoint, S3_ADDRESSING, S3_PRESETS, s3Preset } from "@/lib/s3/presets";
import { useActionData } from "@/lib/hooks/use-action-data";
import { isActionFail } from "@/lib/http/action-result";
import type { S3PresetId, S3ProbeResult, S3Settings } from "@/types/s3";
import { loadStorageSettingsAction, saveStorageSettingsAction, testStorageSettingsAction } from "../_action";
import OptionSelect from "./option-select";
import SaveBar from "./save-bar";
import TabState from "./tab-state";

export default function StorageTab() {
  const t = useTranslations("Settings.storage");
  const tSettings = useTranslations("Settings");
  const showError = useErrorToast();
  const [draft, setDraft] = useState<S3Settings | null>(null);
  const [probe, setProbe] = useState<S3ProbeResult | null>(null);
  const [pending, start] = useTransition();
  const [testing, startTest] = useTransition();
  const page = useActionData(loadStorageSettingsAction);
  const { data: view, setData } = page;

  if (!view) return <TabState state={page} />;

  const settings = draft ?? view.settings;
  const disabled = !view.canManage || pending;
  const preset = s3Preset(settings.preset);
  const keysReady = view.keys.accessKeyId && view.keys.secretAccessKey;
  const endpointPending = hasPlaceholder(settings.endpoint);
  const update = (patch: Partial<S3Settings>) => {
    setDraft({ ...settings, ...patch });
    setProbe(null);
  };

  function pickPreset(id: S3PresetId) {
    const next = s3Preset(id);
    update({
      preset: id,
      region: next.region,
      endpoint: presetEndpoint(next, next.region),
      addressing: next.addressing,
    });
  }

  function changeRegion(region: string) {
    const templated = preset.endpoint.includes("{region}") && settings.endpoint === presetEndpoint(preset, settings.region);
    update({ region, ...(templated ? { endpoint: presetEndpoint(preset, region) } : {}) });
  }

  function save() {
    start(async () => {
      const result = await saveStorageSettingsAction(settings);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      setData(result);
      setDraft(null);
      toast(tSettings("saved"), { variant: "success" });
    });
  }

  function test() {
    startTest(async () => {
      const result = await testStorageSettingsAction(settings);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      setProbe(result);
    });
  }

  return (
    <div className="space-y-5">
      <SaveBar
        description={t("description")}
        canManage={view.canManage}
        pending={pending}
        isDisabled={endpointPending}
        onSave={save}
        extra={
          <Button variant="secondary" isPending={testing} isDisabled={endpointPending || pending} onPress={test}>
            {({ isPending }) => (
              <>
                {isPending ? <Spinner color="current" size="sm" /> : null}
                {t("test")}
              </>
            )}
          </Button>
        }
      />

      {probe ? (
        <Alert status={probe.ok ? "success" : "danger"}>
          <Alert.Indicator />
          <Alert.Content className="min-w-0">
            <Alert.Title>{t("probe.title", { ok: probe.ok ? "true" : "false" })}</Alert.Title>
            <Alert.Description className="break-words">
              {probe.ok
                ? t("probe.ok", { ms: probe.latencyMs, key: probe.key })
                : t("probe.failed", {
                    code: probe.code,
                    step: probe.step ?? "none",
                    status: probe.status ? String(probe.status) : "none",
                  })}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      <SettingSection title={t("bucket.title")} subtitle={t("bucket.subtitle")}>
        <div className="flex flex-wrap items-center gap-3">
          <IconTile icon={HardDrive} tone={view.active ? "success" : "neutral"} />
          <Chip size="sm" variant="soft" color={view.active ? "success" : "default"}>
            {t("state", { active: view.active ? "true" : "false" })}
          </Chip>
        </div>
        <div className="grid gap-4 md:grid-cols-2 md:items-start">
          <OptionSelect
            label={t("preset")}
            value={settings.preset}
            options={S3_PRESETS.map((item) => ({
              id: item.id,
              label: t("presets.name", { id: item.id }),
              description: t("presets.note", { id: item.id }),
            }))}
            onChange={pickPreset}
            isDisabled={disabled}
            description={t("presets.note", { id: settings.preset })}
          />
          <SettingText
            label={t("field", { field: "bucket" })}
            value={settings.bucket}
            onChange={(bucket) => update({ bucket })}
            isDisabled={disabled}
            hint={t("bucketHint")}
          />
          <SettingText
            label={t("field", { field: "region" })}
            value={settings.region}
            onChange={changeRegion}
            isDisabled={disabled}
            placeholder={preset.region}
          />
          <SettingText
            label={t("field", { field: "endpoint" })}
            value={settings.endpoint}
            onChange={(endpoint) => update({ endpoint })}
            isDisabled={disabled}
            placeholder={presetEndpoint(preset, settings.region) || "https://s3.example.com"}
            hint={endpointPending ? t("endpointPlaceholder") : t("endpointHint")}
          />
          <SettingText
            label={t("field", { field: "prefix" })}
            value={settings.prefix}
            onChange={(prefix) => update({ prefix })}
            isDisabled={disabled}
            placeholder="llmhub"
          />
          <OptionSelect
            label={t("field", { field: "addressing" })}
            value={settings.addressing}
            options={S3_ADDRESSING.map((mode) => ({
              id: mode,
              label: t("addressing", { mode: mode.replace("-", "_") }),
              description: t("addressingHint", { mode: mode.replace("-", "_") }),
            }))}
            onChange={(addressing) => update({ addressing })}
            isDisabled={disabled}
          />
        </div>
        {preset.docs ? (
          <a href={preset.docs} target="_blank" rel="noreferrer noopener" className="text-sm font-medium text-accent">
            {t("presets.docs", { id: settings.preset })}
          </a>
        ) : null}
        <Disclosure>
          <Disclosure.Heading>
            <Disclosure.Trigger className="flex w-full items-center justify-between gap-2 text-sm text-muted">
              {tSettings("advanced")}
              <Disclosure.Indicator />
            </Disclosure.Trigger>
          </Disclosure.Heading>
          <Disclosure.Content>
            <Disclosure.Body className="pt-3">
              <SettingText
                label={t("field", { field: "public_base_url" })}
                value={settings.public_base_url}
                onChange={(public_base_url) => update({ public_base_url })}
                isDisabled={disabled}
                placeholder="https://files.example.com"
                hint={t("publicHint")}
              />
            </Disclosure.Body>
          </Disclosure.Content>
        </Disclosure>
      </SettingSection>

      <SettingSection title={t("keys.title")} subtitle={t("keys.subtitle")}>
        <div className="flex items-start gap-3">
          <IconTile icon={KeySquare} tone={keysReady ? "success" : "warning"} />
          <ul className="min-w-0 flex-1 divide-y divide-border">
            {(["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const).map((name) => {
              const set = name === "S3_ACCESS_KEY_ID" ? view.keys.accessKeyId : view.keys.secretAccessKey;
              return (
                <li key={name} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm first:pt-0 last:pb-0">
                  <code className="font-mono text-xs">{name}</code>
                  <Chip size="sm" variant="soft" color={set ? "success" : "warning"}>
                    {t("keys.state", { set: set ? "true" : "false" })}
                  </Chip>
                </li>
              );
            })}
          </ul>
        </div>
        <p className="text-xs text-muted">{t("keys.hint")}</p>
      </SettingSection>
    </div>
  );
}
