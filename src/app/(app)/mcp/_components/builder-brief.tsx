"use client";

import type { Dispatch, SetStateAction } from "react";
import {
  Alert,
  Description,
  Label,
  ListBox,
  Select,
  TextArea,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
} from "@heroui/react";
import { useTranslations } from "next-intl";
import { MCP_BUILDER_TEMPLATES } from "@/schemas/mcp";
import type { McpBuilderModel, McpBuilderTemplate, McpDocsFileRow, McpDocsLinkRow } from "@/types/mcp";
import BuilderSources from "./builder-sources";

export default function BuilderBrief({
  model,
  models,
  template,
  instruction,
  links,
  docs,
  files,
  sourceErrors,
  pending,
  drafting,
  onModel,
  onTemplate,
  onInstruction,
  onLinks,
  onDocs,
  onFiles,
  onSourceErrors,
}: {
  model: string;
  models: McpBuilderModel[];
  template: McpBuilderTemplate;
  instruction: string;
  links: McpDocsLinkRow[];
  docs: string;
  files: McpDocsFileRow[];
  sourceErrors: Record<string, string>;
  pending: boolean;
  drafting: boolean;
  onModel: (model: string) => void;
  onTemplate: (template: McpBuilderTemplate) => void;
  onInstruction: (instruction: string) => void;
  onLinks: Dispatch<SetStateAction<McpDocsLinkRow[]>>;
  onDocs: (docs: string) => void;
  onFiles: Dispatch<SetStateAction<McpDocsFileRow[]>>;
  onSourceErrors: Dispatch<SetStateAction<Record<string, string>>>;
}) {
  const t = useTranslations("Mcp");
  const selected = models.some((item) => item.alias === model) ? model : null;

  function chooseTemplate(next: McpBuilderTemplate) {
    onTemplate(next);
    if (next !== "custom") onInstruction(t("builder.templateText", { template: next }));
  }

  function editInstruction(value: string) {
    onInstruction(value);
    const match = MCP_BUILDER_TEMPLATES.find(
      (item) => item !== "custom" && t("builder.templateText", { template: item }) === value,
    );
    onTemplate(match ?? "custom");
  }

  return (
    <>
      {models.length === 0 ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{t("builder.modelEmpty")}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : (
        <Select
          fullWidth
          selectedKey={selected}
          onSelectionChange={(key) => {
            const next = models.find((item) => item.alias === String(key))?.alias;
            if (next) onModel(next);
          }}
          isDisabled={pending}
        >
          <Label>{t("builder.model")}</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {models.map((item) => (
                <ListBox.Item key={item.alias} id={item.alias} textValue={item.label}>
                  {item.label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
          <Description>{t("builder.modelHint")}</Description>
        </Select>
      )}
      <div className="space-y-2">
        <Label>{t("builder.template")}</Label>
        <ToggleButtonGroup
          isDetached
          className="flex w-full flex-wrap justify-start"
          selectionMode="single"
          disallowEmptySelection
          aria-label={t("builder.template")}
          selectedKeys={[template]}
          onSelectionChange={(keys) => {
            const next = MCP_BUILDER_TEMPLATES.find((item) => item === [...keys][0]);
            if (next) chooseTemplate(next);
          }}
          isDisabled={pending}
        >
          {MCP_BUILDER_TEMPLATES.map((item) => (
            <ToggleButton key={item} id={item}>
              {t("builder.templateName", { template: item })}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <Description>{t("builder.templateHint")}</Description>
      </div>
      <TextField fullWidth isRequired value={instruction} onChange={editInstruction} isDisabled={pending}>
        <Label>{t("builder.instruction")}</Label>
        <TextArea className="min-h-24" />
        <Description>{t("builder.instructionHint")}</Description>
      </TextField>
      <BuilderSources
        links={links}
        docs={docs}
        files={files}
        errors={sourceErrors}
        pending={pending}
        onLinks={onLinks}
        onDocs={onDocs}
        onFiles={onFiles}
        onErrors={onSourceErrors}
      />
      {drafting ? (
        <output aria-live="polite" className="text-sm text-muted">
          {t("builder.drafting")}
        </output>
      ) : null}
    </>
  );
}
