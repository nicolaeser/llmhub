"use client";

import { Checkbox, CheckboxGroup, Description, FieldError, Label } from "@heroui/react";
import { useTranslations } from "next-intl";
import { WEBHOOK_EVENTS } from "@/lib/alerts/events";
import type { WebhookEvent } from "@/types/alerts";

export default function AlertEventsField({
  value,
  onChange,
  isDisabled,
  isInvalid,
}: {
  value: WebhookEvent[];
  onChange: (events: WebhookEvent[]) => void;
  isDisabled: boolean;
  isInvalid: boolean;
}) {
  const t = useTranslations("Settings.logging");

  return (
    <CheckboxGroup
      value={value}
      onChange={(events) => onChange(WEBHOOK_EVENTS.filter((event) => events.includes(event)))}
      isDisabled={isDisabled}
      isInvalid={isInvalid}
    >
      <Label>{t("events")}</Label>
      {WEBHOOK_EVENTS.map((event) => (
        <Checkbox key={event} value={event}>
          <Checkbox.Content>
            <Checkbox.Control>
              <Checkbox.Indicator />
            </Checkbox.Control>
            <Label>{t("eventLabel", { event })}</Label>
          </Checkbox.Content>
          <Description>{t("eventHint", { event })}</Description>
        </Checkbox>
      ))}
      <FieldError>{t("eventsRequired")}</FieldError>
    </CheckboxGroup>
  );
}
