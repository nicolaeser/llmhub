"use client";

import {
  Button,
  Card,
  Checkbox,
  CheckboxGroup,
  Description,
  FieldError,
  Input,
  Label,
  Switch,
  TextField,
} from "@heroui/react";
import { Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { WEBHOOK_EVENTS } from "@/lib/gateway/webhook-events";
import type { AlertWebhookDraft } from "@/types/settings";

export default function WebhookCard({
  draft,
  position,
  isDisabled,
  onChange,
  onRemove,
}: {
  draft: AlertWebhookDraft;
  position: number;
  isDisabled: boolean;
  onChange: (next: AlertWebhookDraft) => void;
  onRemove: () => void;
}) {
  const t = useTranslations("Logging");

  return (
    <Card variant="secondary" className="gap-4">
      <Card.Header className="flex-row items-center justify-between gap-2">
        <Card.Title>{t("webhookTitle", { position })}</Card.Title>
        <Button
          isIconOnly
          size="sm"
          variant="danger-soft"
          aria-label={t("removeWebhook", { position })}
          isDisabled={isDisabled}
          onPress={onRemove}
        >
          <Trash2 size={14} aria-hidden />
        </Button>
      </Card.Header>
      <div className="grid gap-4 md:grid-cols-2 md:items-start">
        <TextField
          fullWidth
          isRequired
          value={draft.url}
          onChange={(url) => onChange({ ...draft, url })}
          isDisabled={isDisabled}
        >
          <Label>{t("webhook")}</Label>
          <Input placeholder="https://hooks.example.com/llmhub" />
        </TextField>
        <div className="space-y-2">
          <TextField
            fullWidth
            value={draft.secret}
            onChange={(secret) => onChange({ ...draft, secret })}
            isDisabled={isDisabled || draft.clearSecret}
          >
            <Label>{t("webhookSecret")}</Label>
            <Input
              type="password"
              placeholder={t("webhookSecretState", { set: draft.secretSet ? "true" : "false" })}
            />
          </TextField>
          {draft.secretSet ? (
            <Switch
              isSelected={draft.clearSecret}
              onChange={(clearSecret) => onChange({ ...draft, clearSecret })}
              isDisabled={isDisabled}
            >
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
                <Label>{t("clearSecret")}</Label>
              </Switch.Content>
            </Switch>
          ) : null}
        </div>
      </div>
      <CheckboxGroup
        value={draft.events}
        onChange={(events) => onChange({ ...draft, events: WEBHOOK_EVENTS.filter((e) => events.includes(e)) })}
        isDisabled={isDisabled}
        isInvalid={draft.events.length === 0}
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
    </Card>
  );
}
