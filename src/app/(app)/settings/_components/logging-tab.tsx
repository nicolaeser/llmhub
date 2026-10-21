"use client";

import { useRef, useState, useTransition } from "react";
import {
  Button,
  Description,
  Label,
  NumberField,
  toast,
} from "@heroui/react";
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { SettingSection, SettingSwitch } from "./setting-fields";
import { formats } from "@/i18n/formats";
import { loadLoggingAction, saveLoggingAction } from "../_action";
import BudgetAlertsCard from "./budget-alerts-card";
import WebhookCard from "./webhook-card";
import SaveBar, { SettingsLead } from "./save-bar";
import TabState from "./tab-state";
import { useActionData } from "@/lib/hooks/use-action-data";
import { isActionFail } from "@/lib/http/action-result";
import {
  DEFAULT_KEY_EXPIRY_WARNING_DAYS,
  DEFAULT_SPEND_ANOMALY_FACTOR,
  DEFAULT_SPEND_ANOMALY_MIN_COST,
} from "@/lib/alerts/rules";
import { MAX_ALERT_WEBHOOKS, WEBHOOK_EVENTS } from "@/lib/alerts/events";
import {
  DEFAULT_CONTENT_RETENTION_DAYS,
  DEFAULT_LOG_RETENTION_DAYS,
  DEFAULT_OBJECT_RETENTION_DAYS,
  DEFAULT_SECURITY_RETENTION_DAYS,
  RETENTION_MAX_DAYS,
} from "@/lib/settings/retention-defaults";
import type { AlertRules, AlertWebhookDraft, LoggingSettingsView } from "@/types/settings";
import { useErrorToast } from "@/components/console/use-error-toast";

export default function LoggingTab() {
  const t = useTranslations("Settings.logging");
  const tSettings = useTranslations("Settings");
  const showError = useErrorToast();
  const [webhooks, setWebhooks] = useState<AlertWebhookDraft[]>([]);
  const [rules, setRules] = useState<AlertRules>({
    spendAnomalyFactor: DEFAULT_SPEND_ANOMALY_FACTOR,
    spendAnomalyMinCost: DEFAULT_SPEND_ANOMALY_MIN_COST,
    keyExpiryWarningDays: DEFAULT_KEY_EXPIRY_WARNING_DAYS,
  });
  const draftSeq = useRef(0);
  const [retention, setRetention] = useState(DEFAULT_LOG_RETENTION_DAYS);
  const [spendRetention, setSpendRetention] = useState(0);
  const [usageRetention, setUsageRetention] = useState(0);
  const [auditRetention, setAuditRetention] = useState(0);
  const [securityRetention, setSecurityRetention] = useState(DEFAULT_SECURITY_RETENTION_DAYS);
  const [objectRetention, setObjectRetention] = useState(DEFAULT_OBJECT_RETENTION_DAYS);
  const [fileRetention, setFileRetention] = useState(0);
  const [contentRetention, setContentRetention] = useState(DEFAULT_CONTENT_RETENTION_DAYS);
  const [archive, setArchive] = useState(false);
  const [content, setContent] = useState(true);
  const [pending, start] = useTransition();

  function seed(next: LoggingSettingsView) {
    setWebhooks(
      next.alertWebhooks.map((hook) => ({
        key: hook.id,
        id: hook.id,
        url: hook.url,
        secret: "",
        clearSecret: false,
        secretSet: hook.secretSet,
        format: hook.format,
        events: hook.events,
      })),
    );
    setRules(next.alertRules);
    setRetention(next.logRetentionDays);
    setSpendRetention(next.spendRetentionDays);
    setUsageRetention(next.usageRetentionDays);
    setAuditRetention(next.auditRetentionDays);
    setSecurityRetention(next.securityRetentionDays);
    setObjectRetention(next.objectRetentionDays);
    setFileRetention(next.fileRetentionDays);
    setContentRetention(next.contentRetentionDays);
    setArchive(next.logArchive);
    setContent(next.logContent);
  }

  const page = useActionData<LoggingSettingsView>(loadLoggingAction, seed);
  const { data: view, setData: setView } = page;

  if (!view) return <TabState state={page} />;

  const disabled = !view.canManage || pending;
  const addWebhook = () => {
    draftSeq.current += 1;
    const key = `new-${draftSeq.current}`;
    setWebhooks((current) => [
      ...current,
      {
        key,
        id: null,
        url: "",
        secret: "",
        clearSecret: false,
        secretSet: false,
        format: "json",
        events: [...WEBHOOK_EVENTS],
      },
    ]);
  };
  const ruleField = (
    field: keyof AlertRules,
    label: string,
    hint: string,
    options: { step: number; format: Intl.NumberFormatOptions },
  ) => (
    <NumberField
      fullWidth
      value={rules[field]}
      onChange={(value) => setRules((current) => ({ ...current, [field]: Number.isFinite(value) ? value : 0 }))}
      minValue={0}
      step={options.step}
      formatOptions={options.format}
      isDisabled={disabled}
    >
      <Label>{label}</Label>
      <NumberField.Group>
        <NumberField.DecrementButton />
        <NumberField.Input />
        <NumberField.IncrementButton />
      </NumberField.Group>
      <Description>{hint}</Description>
    </NumberField>
  );
  const numberField = (value: number, onChange: (next: number) => void, label: string, hint: string) => (
    <NumberField
      fullWidth
      value={value}
      onChange={(next) => onChange(Number.isFinite(next) ? next : 0)}
      minValue={0}
      maxValue={RETENTION_MAX_DAYS}
      step={1}
      formatOptions={formats.number.integer}
      isDisabled={disabled}
    >
      <Label>{label}</Label>
      <NumberField.Group>
        <NumberField.DecrementButton />
        <NumberField.Input />
        <NumberField.IncrementButton />
      </NumberField.Group>
      <Description>{hint}</Description>
    </NumberField>
  );

  return (
    <div className="space-y-5">
      <SettingsLead description={t("description")} canManage={view.canManage} />
      <SettingSection
        title={t("alerts")}
        subtitle={t("alertsHint")}
        footer={
          view.canManage ? (
            <Button
              variant="secondary"
              isDisabled={disabled || webhooks.length >= MAX_ALERT_WEBHOOKS}
              onPress={addWebhook}
            >
              <Plus size={16} aria-hidden />
              {t("addWebhook")}
            </Button>
          ) : null
        }
      >
        {webhooks.length ? (
          webhooks.map((hook, index) => (
            <WebhookCard
              key={hook.key}
              draft={hook}
              position={index + 1}
              canEdit={view.canManage}
              isDisabled={disabled}
              onChange={(next) =>
                setWebhooks((current) => current.map((item) => (item.key === hook.key ? next : item)))
              }
              onRemove={() => setWebhooks((current) => current.filter((item) => item.key !== hook.key))}
            />
          ))
        ) : (
          <p className="text-sm text-muted">{t("noWebhooks")}</p>
        )}
      </SettingSection>
      <SettingSection title={t("rulesTitle")} subtitle={t("rulesHint")}>
        <div className="grid gap-4 md:grid-cols-3 md:items-start">
          {ruleField("spendAnomalyFactor", t("anomalyFactor"), t("anomalyFactorHint"), {
            step: 0.5,
            format: formats.number.factor,
          })}
          {ruleField("spendAnomalyMinCost", t("anomalyMinCost"), t("anomalyMinCostHint"), {
            step: 1,
            format: formats.number.currency,
          })}
          {ruleField("keyExpiryWarningDays", t("expiryDays"), t("expiryDaysHint"), {
            step: 1,
            format: formats.number.integer,
          })}
        </div>
      </SettingSection>
      <BudgetAlertsCard
        thresholds={view.budgetAlerts.thresholds}
        canManage={view.budgetAlerts.canManage}
        onSaved={(thresholds) =>
          setView((current) => ({ ...current, budgetAlerts: { ...current.budgetAlerts, thresholds } }))
        }
      />
      <SettingSection title={t("contentTitle")} subtitle={t("contentSubtitle")}>
        <SettingSwitch
          label={t("content")}
          isSelected={content}
          onChange={setContent}
          isDisabled={disabled}
          hint={t("contentHint")}
        />
        <div className="grid gap-4 md:grid-cols-3 md:items-start">
          {numberField(contentRetention, setContentRetention, t("contentRetention"), t("contentRetentionHint", { days: DEFAULT_CONTENT_RETENTION_DAYS }))}
        </div>
      </SettingSection>
      <SettingSection title={t("retentionTitle")}>
        <div className="grid gap-4 md:grid-cols-3 md:items-start">
          {numberField(retention, setRetention, t("retention"), t("retentionHint", { days: DEFAULT_LOG_RETENTION_DAYS }))}
          {numberField(spendRetention, setSpendRetention, t("spendRetention"), t("spendRetentionHint"))}
          {numberField(usageRetention, setUsageRetention, t("usageRetention"), t("usageRetentionHint"))}
          {numberField(auditRetention, setAuditRetention, t("auditRetention"), t("auditRetentionHint"))}
          {numberField(securityRetention, setSecurityRetention, t("securityRetention"), t("securityRetentionHint", { days: DEFAULT_SECURITY_RETENTION_DAYS }))}
          {numberField(objectRetention, setObjectRetention, t("objectRetention"), t("objectRetentionHint", { days: DEFAULT_OBJECT_RETENTION_DAYS }))}
          {numberField(fileRetention, setFileRetention, t("fileRetention"), t("fileRetentionHint"))}
        </div>
        <SettingSwitch
          label={t("archive")}
          isSelected={archive}
          onChange={setArchive}
          isDisabled={disabled || (!archive && !view.s3Ready)}
          hint={t("archiveHint", { ready: view.s3Ready ? "true" : "false" })}
        />
      </SettingSection>
      <SaveBar
        canManage={view.canManage}
        pending={pending}
        onSave={() =>
          start(async () => {
            const result = await saveLoggingAction({
              alertWebhooks: webhooks.map((hook) => ({
                id: hook.id,
                url: hook.url,
                secret: hook.secret,
                clearSecret: hook.clearSecret,
                format: hook.format,
                events: hook.events,
              })),
              alertRules: rules,
              logRetentionDays: retention,
              spendRetentionDays: spendRetention,
              usageRetentionDays: usageRetention,
              auditRetentionDays: auditRetention,
              securityRetentionDays: securityRetention,
              objectRetentionDays: objectRetention,
              fileRetentionDays: fileRetention,
              contentRetentionDays: contentRetention,
              logArchive: archive,
              logContent: content,
            });
            if (isActionFail(result)) {
              showError(result.error);
              return;
            }
            setView(result);
            seed(result);
            toast(tSettings("saved"), { variant: "success" });
          })
        }
      />
    </div>
  );
}
