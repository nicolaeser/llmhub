"use client";

import { Button, Disclosure, TextArea } from "@heroui/react";
import { Trash } from "lucide-react";
import { useTranslations } from "next-intl";
import SearchSelect from "@/components/console/search-select";

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
        <SearchSelect
          label={t("model")}
          placeholder={t("noModels")}
          items={models.map((m) => ({ id: m, label: m }))}
          value={model}
          onChange={onModelChange}
          isDisabled={!models.length}
          className="min-w-44 flex-1"
        />
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
