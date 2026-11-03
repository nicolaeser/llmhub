"use client";

import { Alert, Description, FieldError, Label, TextArea, TextField } from "@heroui/react";
import { useFormatter, useTranslations } from "next-intl";
import { MAX_ALERT_EMAILS } from "@/lib/alerts/events";
import { alertRecipientSchema } from "@/schemas/settings";
import { SettingSection } from "./setting-fields";
import AlertEventsField from "./alert-events-field";
import type { WebhookEvent } from "@/types/alerts";

export function splitAlertRecipients(value: string): string[] {
  return value.split(/[\s,;]+/).filter(Boolean);
}

export default function AlertEmailsSection({
  recipients,
  events,
  mailEnabled,
  isDisabled,
  onRecipientsChange,
  onEventsChange,
}: {
  recipients: string;
  events: WebhookEvent[];
  mailEnabled: boolean;
  isDisabled: boolean;
  onRecipientsChange: (value: string) => void;
  onEventsChange: (events: WebhookEvent[]) => void;
}) {
  const t = useTranslations("Settings.logging.emails");
  const format = useFormatter();
  const list = splitAlertRecipients(recipients);
  const invalid = list.filter((value) => !alertRecipientSchema.safeParse(value).success);
  const tooMany = new Set(list.map((value) => value.toLowerCase())).size > MAX_ALERT_EMAILS;

  return (
    <SettingSection title={t("title")} subtitle={t("hint")}>
      {mailEnabled ? null : (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content className="min-w-0">
            <Alert.Title>{t("smtpTitle")}</Alert.Title>
            <Alert.Description>{t("smtpHint")}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      <TextField
        fullWidth
        value={recipients}
        onChange={onRecipientsChange}
        isDisabled={isDisabled}
        isInvalid={invalid.length > 0 || tooMany}
      >
        <Label>{t("recipients")}</Label>
        <TextArea rows={3} placeholder="ops@example.com" />
        <Description>{t("recipientsHint", { max: MAX_ALERT_EMAILS })}</Description>
        <FieldError>
          {invalid.length
            ? t("recipientsInvalid", { list: format.list(invalid, "enumeration") })
            : t("recipientsTooMany", { max: MAX_ALERT_EMAILS })}
        </FieldError>
      </TextField>
      <AlertEventsField
        value={events}
        onChange={onEventsChange}
        isDisabled={isDisabled}
        isInvalid={list.length > 0 && events.length === 0}
      />
    </SettingSection>
  );
}
