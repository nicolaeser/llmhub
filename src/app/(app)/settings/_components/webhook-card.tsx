"use client";

import { Button, Card, Description, Input, Label, ListBox, Select, TextField } from "@heroui/react";
import { Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { WEBHOOK_FORMATS } from "@/lib/alerts/events";
import AlertEventsField from "./alert-events-field";
import type { AlertWebhookDraft } from "@/types/settings";

export default function WebhookCard({
  draft,
  position,
  canEdit,
  isDisabled,
  onChange,
  onRemove,
}: {
  draft: AlertWebhookDraft;
  position: number;
  canEdit: boolean;
  isDisabled: boolean;
  onChange: (next: AlertWebhookDraft) => void;
  onRemove: () => void;
}) {
  const t = useTranslations("Settings.logging");

  return (
    <Card variant="secondary" className="gap-4">
      <Card.Header className="flex-row items-center justify-between gap-2">
        <Card.Title>{t("webhookTitle", { position })}</Card.Title>
        {canEdit ? (
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
        ) : null}
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
        {canEdit ? (
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
              <Button
                size="sm"
                variant={draft.clearSecret ? "secondary" : "danger-soft"}
                isDisabled={isDisabled}
                onPress={() => onChange({ ...draft, clearSecret: !draft.clearSecret, secret: "" })}
              >
                {draft.clearSecret ? t("keepSecret") : t("clearSecret")}
              </Button>
            ) : null}
          </div>
        ) : null}
        <Select
          fullWidth
          selectedKey={draft.format}
          onSelectionChange={(key) =>
            onChange({ ...draft, format: WEBHOOK_FORMATS.find((format) => format === key) ?? "json" })
          }
          isDisabled={isDisabled}
        >
          <Label>{t("format")}</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox aria-label={t("format")}>
              {WEBHOOK_FORMATS.map((format) => (
                <ListBox.Item key={format} id={format} textValue={t("formatLabel", { format })}>
                  {t("formatLabel", { format })}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
          <Description>{t("formatHint", { format: draft.format })}</Description>
        </Select>
      </div>
      <AlertEventsField
        value={draft.events}
        onChange={(events) => onChange({ ...draft, events })}
        isDisabled={isDisabled}
        isInvalid={draft.events.length === 0}
      />
    </Card>
  );
}
