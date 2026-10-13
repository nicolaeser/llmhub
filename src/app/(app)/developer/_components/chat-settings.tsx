"use client";

import { Button, Disclosure, TextArea } from "@heroui/react";
import { Trash } from "lucide-react";
import { useTranslations } from "next-intl";
import SearchSelect from "@/components/console/search-select";

export default function ChatSettings({
  models,
  model,
  system,
  toolsJson,
  pending,
  onModelChange,
  onSystemChange,
  onToolsChange,
  onClear,
}: {
  models: string[];
  model: string;
  system: string;
  toolsJson: string;
  pending: boolean;
  onModelChange: (model: string) => void;
  onSystemChange: (value: string) => void;
  onToolsChange: (value: string) => void;
  onClear: () => void;
}) {
  const t = useTranslations("Playground");
  return (
    <>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <SearchSelect
          label={t("model")}
          placeholder={models.length ? t("pickModel") : t("noModels")}
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
      <Disclosure className="mb-3" defaultExpanded={Boolean(system)}>
        <Disclosure.Heading level={2}>
          <Disclosure.Trigger className="flex w-full items-center justify-between text-sm text-muted">
            {t("system")}
            <Disclosure.Indicator />
          </Disclosure.Trigger>
        </Disclosure.Heading>
        <Disclosure.Content>
          <Disclosure.Body className="space-y-2 pt-2">
            <p className="text-xs text-muted">{t("systemHint")}</p>
            <TextArea
              fullWidth
              aria-label={t("system")}
              value={system}
              onChange={(e) => onSystemChange(e.target.value)}
              placeholder={t("systemPlaceholder")}
              className="min-h-24"
            />
          </Disclosure.Body>
        </Disclosure.Content>
      </Disclosure>
      <Disclosure className="mb-3" defaultExpanded={Boolean(toolsJson)}>
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
