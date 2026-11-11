"use client";

import { useState, useTransition } from "react";
import {
  Alert,
  Button,
  Checkbox,
  CheckboxGroup,
  Chip,
  Description,
  Input,
  Label,
  NumberField,
  Spinner,
  TextField,
  toast,
} from "@heroui/react";
import { useTranslations } from "next-intl";
import ChoiceCards from "@/components/console/choice-cards";
import { useErrorToast } from "@/components/console/use-error-toast";
import { formats } from "@/i18n/formats";
import { Link } from "@/i18n/routing";
import {
  ARCHIVE_DATASETS,
  ARCHIVE_FORMATS,
  ARCHIVE_LOCK_MODES,
  ARCHIVE_PASSWORD_MIN,
  DEFAULT_ARCHIVE_PREFIX,
} from "@/lib/compliance-archive/options";
import { useActionData } from "@/lib/hooks/use-action-data";
import { isActionFail } from "@/lib/http/action-result";
import { RETENTION_MAX_DAYS } from "@/lib/settings/retention-defaults";
import type { ArchiveFormat, ComplianceArchiveInput, ComplianceArchiveView } from "@/types/archive";
import type { S3ProbeResult } from "@/types/s3";
import {
  loadComplianceArchiveAction,
  retryComplianceArchiveAction,
  saveComplianceArchiveAction,
  testComplianceArchiveAction,
} from "../_action";
import ArchiveRuns from "./archive-runs";
import OptionSelect from "./option-select";
import SaveBar, { SettingsLead } from "./save-bar";
import { SettingSection, SettingSwitch, SettingText } from "./setting-fields";
import TabState from "./tab-state";

const EXTENSIONS: Record<ArchiveFormat, string> = { jsonl: ".jsonl", jsonl_gzip: ".jsonl.gz", zip_aes: ".zip" };

function draftOf(view: ComplianceArchiveView): ComplianceArchiveInput {
  return { ...view.settings, password: "", clearPassword: false };
}

function samplePath(view: ComplianceArchiveView, form: ComplianceArchiveInput): string {
  const bucket = form.bucket || view.storage.bucket || "bucket";
  const parts = [bucket, view.storage.storagePrefix, form.prefix || DEFAULT_ARCHIVE_PREFIX, "requests", "2026", "11"]
    .map((part) => part.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
  return `${parts.join("/")}/requests-2026-11-10${EXTENSIONS[form.format]}`;
}

export default function ArchiveTab() {
  const t = useTranslations("Settings.archive");
  const tStorage = useTranslations("Settings.storage");
  const tSettings = useTranslations("Settings");
  const showError = useErrorToast();
  const [draft, setDraft] = useState<ComplianceArchiveInput | null>(null);
  const [probe, setProbe] = useState<S3ProbeResult | null>(null);
  const [pending, start] = useTransition();
  const [testing, startTest] = useTransition();
  const [retrying, startRetry] = useTransition();
  const page = useActionData(loadComplianceArchiveAction);
  const { data: view, setData } = page;

  if (!view) return <TabState state={page} />;

  const form = draft ?? draftOf(view);
  const disabled = !view.canManage || pending;
  const update = (patch: Partial<ComplianceArchiveInput>) => {
    setDraft({ ...form, ...patch });
    setProbe(null);
  };
  const passwordTooShort = form.password.length > 0 && form.password.length < ARCHIVE_PASSWORD_MIN;
  const passwordMissing = form.format === "zip_aes" && !form.password && (!view.passwordSet || form.clearPassword);
  const lockWithoutRetention = form.lock_mode !== "none" && form.retention_days <= 0;

  function applied(next: ComplianceArchiveView) {
    setData(next);
    setDraft(null);
  }

  function save() {
    start(async () => {
      const result = await saveComplianceArchiveAction(form);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      applied(result);
      toast(tSettings("saved"), { variant: "success" });
    });
  }

  function test() {
    startTest(async () => {
      const result = await testComplianceArchiveAction(form);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      setProbe(result);
    });
  }

  function retry() {
    startRetry(async () => {
      const result = await retryComplianceArchiveAction();
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      setData(result);
      toast(t("runs.retried"), { variant: "success" });
    });
  }

  return (
    <div className="space-y-8">
      <SettingsLead description={t("description")} canManage={view.canManage} />

      {!view.storage.ready ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content className="min-w-0">
            <Alert.Title>{t("storageMissing.title")}</Alert.Title>
            <Alert.Description>
              {t.rich("storageMissing.body", {
                link: (chunks) => (
                  <Link href="/settings?tab=storage" className="font-medium text-accent">
                    {chunks}
                  </Link>
                ),
              })}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      {probe ? (
        <Alert status={probe.ok ? "success" : "danger"}>
          <Alert.Indicator />
          <Alert.Content className="min-w-0">
            <Alert.Title>{tStorage("probe.title", { ok: probe.ok ? "true" : "false" })}</Alert.Title>
            <Alert.Description className="break-words">
              {probe.ok
                ? tStorage("probe.ok", { ms: probe.latencyMs, key: probe.key })
                : tStorage("probe.failed", {
                    code: probe.code,
                    step: probe.step ?? "none",
                    status: probe.status ? String(probe.status) : "none",
                  })}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      <SettingSection title={t("daily.title")} subtitle={t("daily.subtitle")}>
        <div className="flex flex-wrap items-center gap-2">
          <Chip size="sm" variant="soft" color={view.settings.enabled ? "success" : "default"}>
            {t("daily.state", { on: view.settings.enabled ? "true" : "false" })}
          </Chip>
          {view.summary.failed ? (
            <Chip size="sm" variant="soft" color="danger">
              {t("daily.failed", { count: view.summary.failed })}
            </Chip>
          ) : null}
          {view.summary.pending ? (
            <Chip size="sm" variant="soft">
              {t("daily.pending", { count: view.summary.pending })}
            </Chip>
          ) : null}
        </div>
        <SettingSwitch
          label={t("daily.enabled")}
          isSelected={form.enabled}
          onChange={(enabled) => update({ enabled })}
          isDisabled={disabled || (!form.enabled && !view.storage.ready)}
          hint={t("daily.enabledHint")}
        />
        <CheckboxGroup
          value={form.datasets}
          onChange={(values) => update({ datasets: ARCHIVE_DATASETS.filter((dataset) => values.includes(dataset)) })}
          isDisabled={disabled}
          isInvalid={form.enabled && !form.datasets.length}
        >
          <Label>{t("daily.datasets")}</Label>
          {ARCHIVE_DATASETS.map((dataset) => (
            <Checkbox key={dataset} value={dataset}>
              <Checkbox.Content>
                <Checkbox.Control>
                  <Checkbox.Indicator />
                </Checkbox.Control>
                <Label>{t("dataset", { dataset })}</Label>
              </Checkbox.Content>
              <Description>{t("datasetHint", { dataset })}</Description>
            </Checkbox>
          ))}
        </CheckboxGroup>
        <SettingSwitch
          label={t("daily.content")}
          isSelected={form.include_content}
          onChange={(include_content) => update({ include_content })}
          isDisabled={disabled || !form.datasets.includes("requests")}
          hint={t("daily.contentHint")}
        />
      </SettingSection>

      <SettingSection title={t("format.title")} subtitle={t("format.subtitle")}>
        <ChoiceCards
          label={t("format.label")}
          value={form.format}
          options={ARCHIVE_FORMATS.map((id) => ({ id, label: t("format.name", { format: id }), hint: t("format.hint", { format: id }) }))}
          onChange={(format) => update({ format })}
          isDisabled={disabled}
        />
        {form.format === "zip_aes" && view.canManage ? (
          <div className="space-y-3">
            <TextField
              fullWidth
              value={form.password}
              onChange={(password) => update({ password })}
              isDisabled={disabled || form.clearPassword}
              isInvalid={passwordTooShort || passwordMissing}
            >
              <Label>{t("format.password")}</Label>
              <Input
                type="password"
                autoComplete="new-password"
                placeholder={t("format.passwordState", { set: view.passwordSet && !form.clearPassword ? "true" : "false" })}
              />
              <Description>{t("format.passwordHint", { min: ARCHIVE_PASSWORD_MIN })}</Description>
            </TextField>
            {view.passwordSet ? (
              <Button
                size="sm"
                variant={form.clearPassword ? "secondary" : "danger-soft"}
                isDisabled={disabled}
                onPress={() => update({ clearPassword: !form.clearPassword, password: "" })}
              >
                {form.clearPassword ? t("format.keepPassword") : t("format.clearPassword")}
              </Button>
            ) : null}
            <Alert status="warning">
              <Alert.Indicator />
              <Alert.Content className="min-w-0">
                <Alert.Title>{t("format.keepSafe.title")}</Alert.Title>
                <Alert.Description>{t("format.keepSafe.body")}</Alert.Description>
              </Alert.Content>
            </Alert>
          </div>
        ) : null}
      </SettingSection>

      <SettingSection title={t("destination.title")} subtitle={t("destination.subtitle")}>
        <div className="grid gap-4 md:grid-cols-2 md:items-start">
          <SettingText
            label={t("destination.bucket")}
            value={form.bucket}
            onChange={(bucket) => update({ bucket })}
            isDisabled={disabled}
            placeholder={view.storage.bucket || undefined}
            hint={t("destination.bucketHint")}
          />
          <SettingText
            label={t("destination.prefix")}
            value={form.prefix}
            onChange={(prefix) => update({ prefix })}
            isDisabled={disabled}
            placeholder={DEFAULT_ARCHIVE_PREFIX}
            hint={t("destination.prefixHint")}
          />
        </div>
        <div className="space-y-1">
          <p className="text-xs text-muted">{t("destination.example")}</p>
          <code className="block font-mono text-xs break-all text-foreground">{samplePath(view, form)}</code>
        </div>
      </SettingSection>

      <SettingSection title={t("retention.title")} subtitle={t("retention.subtitle")}>
        <div className="grid gap-4 md:grid-cols-2 md:items-start">
          <NumberField
            fullWidth
            value={form.retention_days}
            onChange={(value) => update({ retention_days: Number.isFinite(value) ? value : 0 })}
            minValue={0}
            maxValue={RETENTION_MAX_DAYS}
            step={1}
            formatOptions={formats.number.integer}
            isDisabled={disabled}
            isInvalid={lockWithoutRetention}
          >
            <Label>{t("retention.days")}</Label>
            <NumberField.Group>
              <NumberField.DecrementButton />
              <NumberField.Input />
              <NumberField.IncrementButton />
            </NumberField.Group>
            <Description>{t("retention.daysHint")}</Description>
          </NumberField>
          <OptionSelect
            label={t("retention.lock")}
            value={form.lock_mode}
            options={ARCHIVE_LOCK_MODES.map((mode) => ({
              id: mode,
              label: t("retention.lockName", { mode }),
              description: t("retention.lockHint", { mode }),
            }))}
            onChange={(lock_mode) => update({ lock_mode })}
            isDisabled={disabled}
            description={lockWithoutRetention ? t("retention.lockNeedsDays") : t("retention.lockNote")}
          />
        </div>
        <p className="text-sm text-muted">
          {view.summary.heldSince
            ? t("retention.held", { day: new Date(`${view.summary.heldSince}T00:00:00Z`) })
            : t("retention.database", { on: view.settings.enabled ? "true" : "false" })}
        </p>
      </SettingSection>

      <SettingSection
        title={t("runs.title")}
        subtitle={t("runs.subtitle")}
        footer={
          view.canManage && view.summary.failed ? (
            <Button variant="secondary" isPending={retrying} onPress={retry}>
              {({ isPending }) => (
                <>
                  {isPending ? <Spinner color="current" size="sm" /> : null}
                  {t("runs.retryNow")}
                </>
              )}
            </Button>
          ) : null
        }
      >
        <p className="text-sm text-muted">
          {view.summary.lastDay
            ? t("runs.last", { day: new Date(`${view.summary.lastDay}T00:00:00Z`), count: view.summary.done })
            : t("runs.never")}
        </p>
        <ArchiveRuns runs={view.runs} />
      </SettingSection>

      <SaveBar
        canManage={view.canManage}
        pending={pending}
        isDisabled={passwordTooShort || passwordMissing || lockWithoutRetention}
        onSave={save}
        extra={
          <Button variant="secondary" isPending={testing} isDisabled={pending || !view.storage.ready} onPress={test}>
            {({ isPending }) => (
              <>
                {isPending ? <Spinner color="current" size="sm" /> : null}
                {t("test")}
              </>
            )}
          </Button>
        }
      />
    </div>
  );
}
