"use client";

import { Button, Disclosure, Label, ListBox, Select, TextArea } from "@heroui/react";
import { Trash } from "lucide-react";
import { useTranslations } from "next-intl";

export default function ChatSettings({
  models,
  model,
  toolsJson,
  pending,
  onModelChange,
  onToolsChange,
  onClear,
}: {
  models: string[];
  model: string;
  toolsJson: string;
  pending: boolean;
  onModelChange: (model: string) => void;
  onToolsChange: (value: string) => void;
  onClear: () => void;
}) {
  const t = useTranslations("Playground");
  return (
    <>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <Select
          selectedKey={model || null}
          onSelectionChange={(key) => onModelChange(String(key))}
          aria-label={t("model")}
          className="min-w-44 flex-1"
          fullWidth
          isDisabled={!models.length}
          placeholder={t("noModels")}
        >
          <Label>{t("model")}</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox aria-label={t("model")}>
              {models.map((m) => (
                <ListBox.Item key={m} id={m} textValue={m}>
                  {m}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
        <Button variant="ghost" aria-label={t("clear")} isDisabled={pending} onPress={onClear}>
          <Trash size={14} aria-hidden />
          {t("clear")}
        </Button>
      </div>
      <Disclosure className="mb-3">
        <Disclosure.Heading level={2}>
          <Disclosure.Trigger className="flex w-full items-center justify-between text-sm text-muted">
            {t("tools")}
            <Disclosure.Indicator />
          </Disclosure.Trigger>
        </Disclosure.Heading>
        <Disclosure.Content>
          <Disclosure.Body className="space-y-2 pt-2">
            <p className="text-xs text-muted">{t("toolsHint")}</p>
            <TextArea
              fullWidth
              aria-label={t("tools")}
              value={toolsJson}
              onChange={(e) => onToolsChange(e.target.value)}
              placeholder={t("toolsPlaceholder")}
              className="min-h-24 font-mono text-xs"
            />
          </Disclosure.Body>
        </Disclosure.Content>
      </Disclosure>
    </>
  );
}
