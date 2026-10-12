"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  Button,
  Card,
  Description,
  Input,
  Label,
  NumberField,
  Spinner,
  Switch,
  TextField,
  toast,
} from "@heroui/react";
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import PageHeader from "@/components/console/page-header";
import { formats } from "@/i18n/formats";
import { loadLoggingAction, saveLoggingAction } from "@/app/(app)/logging/_action";
import WebhookCard from "@/app/(app)/logging/_components/webhook-card";
import { isActionFail } from "@/lib/http/action-result";
import {
  DEFAULT_KEY_EXPIRY_WARNING_DAYS,
  DEFAULT_SPEND_ANOMALY_FACTOR,
  DEFAULT_SPEND_ANOMALY_MIN_COST,
} from "@/lib/gateway/alert-rules";
import { MAX_ALERT_WEBHOOKS, WEBHOOK_EVENTS } from "@/lib/gateway/webhook-events";
import type { AlertRules, AlertWebhookDraft, AlertWebhookView } from "@/types/settings";

type LoggingView = {
  alertWebhooks: AlertWebhookView[];
  alertRules: AlertRules;
  logRetentionDays: number;
  spendRetentionDays: number;
  auditRetentionDays: number;
  objectRetentionDays: number;
  fileRetentionDays: number;
  contentRetentionDays: number;
  logArchive: boolean;
  logContent: boolean;
  s3Ready: boolean;
  canManage: boolean;
};

export default function LoggingPage() {
  const t = useTranslations("Logging");
  const tError = useTranslations("Error");
  const tCommon = useTranslations("Common");
  const [view, setView] = useState<LoggingView | null>(null);
  const [webhooks, setWebhooks] = useState<AlertWebhookDraft[]>([]);
  const [rules, setRules] = useState<AlertRules>({
    spendAnomalyFactor: DEFAULT_SPEND_ANOMALY_FACTOR,
    spendAnomalyMinCost: DEFAULT_SPEND_ANOMALY_MIN_COST,
    keyExpiryWarningDays: DEFAULT_KEY_EXPIRY_WARNING_DAYS,
  });
  const draftSeq = useRef(0);
  const [retention, setRetention] = useState("0");
  const [spendRetention, setSpendRetention] = useState("0");
  const [auditRetention, setAuditRetention] = useState("0");
  const [objectRetention, setObjectRetention] = useState("30");
  const [fileRetention, setFileRetention] = useState("0");
  const [contentRetention, setContentRetention] = useState("0");
  const [archive, setArchive] = useState(false);
  const [content, setContent] = useState(true);
  const [pending, start] = useTransition();

  function apply(next: LoggingView) {
    setView(next);
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
    setRetention(String(next.logRetentionDays));
    setSpendRetention(String(next.spendRetentionDays));
    setAuditRetention(String(next.auditRetentionDays));
    setObjectRetention(String(next.objectRetentionDays));
    setFileRetention(String(next.fileRetentionDays));
    setContentRetention(String(next.contentRetentionDays));
    setArchive(next.logArchive);
    setContent(next.logContent);
  }

  useEffect(() => {
    loadLoggingAction().then((res) => {
      if (!isActionFail(res)) apply(res);
    });
  }, []);

  if (!view) {
    return (
      <output
        aria-live="polite"
        aria-label={tCommon("loading")}
        className="flex min-h-[40vh] items-center justify-center text-accent"
      >
        <Spinner color="current" size="lg" />
      </output>
    );
  }

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
  const numberField = (value: string, onChange: (next: string) => void, label: string, hint: string) => (
    <TextField fullWidth value={value} onChange={onChange} isDisabled={disabled}>
      <Label>{label}</Label>
      <Input inputMode="numeric" />
      <Description>{hint}</Description>
    </TextField>
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          view.canManage ? (
            <Button
              isPending={pending}
              onPress={() =>
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
                    logRetentionDays: Number(retention) || 0,
                    spendRetentionDays: Number(spendRetention) || 0,
                    auditRetentionDays: Number(auditRetention) || 0,
                    objectRetentionDays: Number(objectRetention) || 0,
                    fileRetentionDays: Number(fileRetention) || 0,
                    contentRetentionDays: Number(contentRetention) || 0,
                    logArchive: archive,
                    logContent: content,
                  });
                  if (isActionFail(result)) {
                    toast.danger(tError("code", { code: result.error }));
                    return;
                  }
                  apply(result);
                  toast(t("saved"), { variant: "success" });
                })
              }
            >
              {({ isPending }) => (
                <>
                  {isPending ? <Spinner color="current" size="sm" /> : null}
                  {t("save")}
                </>
              )}
            </Button>
          ) : undefined
        }
      />
      <Card className="gap-4">
        <Card.Header>
          <Card.Title>{t("alerts")}</Card.Title>
          <Card.Description>{t("alertsHint")}</Card.Description>
        </Card.Header>
        {webhooks.length ? (
          webhooks.map((hook, index) => (
            <WebhookCard
              key={hook.key}
              draft={hook}
              position={index + 1}
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
        {view.canManage ? (
          <Card.Footer>
            <Button
              variant="secondary"
              isDisabled={disabled || webhooks.length >= MAX_ALERT_WEBHOOKS}
              onPress={addWebhook}
            >
              <Plus size={16} aria-hidden />
              {t("addWebhook")}
            </Button>
          </Card.Footer>
        ) : null}
      </Card>
      <Card className="gap-4">
        <Card.Header>
          <Card.Title>{t("rulesTitle")}</Card.Title>
          <Card.Description>{t("rulesHint")}</Card.Description>
        </Card.Header>
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
      </Card>
      <Card className="gap-4">
        <Card.Header>
          <Card.Title>{t("contentTitle")}</Card.Title>
          <Card.Description>{t("contentSubtitle")}</Card.Description>
        </Card.Header>
        <Switch isSelected={content} onChange={setContent} isDisabled={disabled}>
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            <Label>{t("content")}</Label>
          </Switch.Content>
          <Description>{t("contentHint")}</Description>
        </Switch>
        <div className="grid gap-4 md:grid-cols-3 md:items-start">
          {numberField(contentRetention, setContentRetention, t("contentRetention"), t("contentRetentionHint"))}
        </div>
      </Card>
      <Card className="gap-4">
        <Card.Header>
          <Card.Title>{t("retentionTitle")}</Card.Title>
        </Card.Header>
        <div className="grid gap-4 md:grid-cols-3 md:items-start">
          {numberField(retention, setRetention, t("retention"), t("retentionHint"))}
          {numberField(spendRetention, setSpendRetention, t("spendRetention"), t("spendRetentionHint"))}
          {numberField(auditRetention, setAuditRetention, t("auditRetention"), t("auditRetentionHint"))}
          {numberField(objectRetention, setObjectRetention, t("objectRetention"), t("objectRetentionHint"))}
          {numberField(fileRetention, setFileRetention, t("fileRetention"), t("fileRetentionHint"))}
        </div>
        <Switch isSelected={archive} onChange={setArchive} isDisabled={disabled || !view.s3Ready}>
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            <Label>{t("archive")}</Label>
          </Switch.Content>
          <Description>{t("archiveHint", { ready: view.s3Ready ? "true" : "false" })}</Description>
        </Switch>
      </Card>
    </div>
  );
}
