"use client";

import { Description, Label, ListBox, Select } from "@heroui/react";
import { useTranslations } from "next-intl";
import { MCP_ACCESS_LEVELS, MCP_SCOPES } from "@/schemas/mcp";
import type { McpAccessLevel } from "@/types/mcp";
import type { AssignmentScope } from "@/types/providers";

export function ScopeSelect({
  value,
  onChange,
  isDisabled,
}: {
  value: AssignmentScope;
  onChange: (next: AssignmentScope) => void;
  isDisabled?: boolean;
}) {
  const t = useTranslations("Mcp.assign");
  return (
    <Select
      fullWidth
      selectedKey={value}
      onSelectionChange={(key) => {
        const next = MCP_SCOPES.find((item) => item === String(key));
        if (next) onChange(next);
      }}
      isDisabled={isDisabled}
    >
      <Label>{t("scopeLabel")}</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox aria-label={t("scopeLabel")}>
          {MCP_SCOPES.map((item) => (
            <ListBox.Item key={item} id={item} textValue={t("scope", { scope: item })}>
              {t("scope", { scope: item })}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

export function DefaultAccessSelect({
  value,
  onChange,
  isDisabled,
}: {
  value: McpAccessLevel;
  onChange: (next: McpAccessLevel) => void;
  isDisabled?: boolean;
}) {
  const t = useTranslations("Mcp.access");
  return (
    <Select
      fullWidth
      selectedKey={value}
      onSelectionChange={(key) => {
        const next = MCP_ACCESS_LEVELS.find((item) => item === String(key));
        if (next) onChange(next);
      }}
      isDisabled={isDisabled}
    >
      <Label>{t("defaultLabel")}</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox aria-label={t("defaultLabel")}>
          {MCP_ACCESS_LEVELS.map((level) => (
            <ListBox.Item key={level} id={level} textValue={t("level", { access: level })}>
              <div className="flex min-w-0 flex-col">
                <Label>{t("level", { access: level })}</Label>
                <Description>{t("levelHint", { access: level, context: "default" })}</Description>
              </div>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
      <Description>{t("defaultHint")}</Description>
    </Select>
  );
}
