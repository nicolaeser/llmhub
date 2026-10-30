"use client";

import { Description, Label, ListBox, Select, ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { useTranslations } from "next-intl";
import { MCP_MODES, MCP_SCOPES } from "@/schemas/mcp";
import type { McpAssignmentMode, McpAssignmentView } from "@/types/mcp";
import type { AssignmentScope } from "@/types/providers";

export type RoleChoice = { id: string; label: string; apply: Pick<McpAssignmentView, "roleId" | "role"> };

export const NO_ROLE = "none";

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

export function ModeField({
  value,
  onChange,
  isDisabled,
}: {
  value: McpAssignmentMode;
  onChange: (next: McpAssignmentMode) => void;
  isDisabled?: boolean;
}) {
  const t = useTranslations("Mcp.assign");
  return (
    <div className="flex flex-col items-start gap-2">
      <Label>{t("modeLabel")}</Label>
      <ToggleButtonGroup
        selectionMode="single"
        disallowEmptySelection
        aria-label={t("modeLabel")}
        selectedKeys={[value]}
        onSelectionChange={(keys) => {
          const next = MCP_MODES.find((item) => item === [...keys][0]);
          if (next) onChange(next);
        }}
        isDisabled={isDisabled}
      >
        {MCP_MODES.map((item, index) => (
          <ToggleButton key={item} id={item}>
            {index > 0 ? <ToggleButtonGroup.Separator /> : null}
            {t("mode", { mode: item })}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      <Description>{t("modeHint", { mode: value })}</Description>
    </div>
  );
}

export function RoleField({
  roles,
  value,
  onChange,
  isDisabled,
}: {
  roles: readonly RoleChoice[];
  value: string;
  onChange: (choice: RoleChoice | null) => void;
  isDisabled?: boolean;
}) {
  const t = useTranslations("Mcp.assign");
  return (
    <Select
      fullWidth
      selectedKey={value}
      onSelectionChange={(key) => onChange(roles.find((role) => role.id === String(key)) ?? null)}
      isDisabled={isDisabled}
    >
      <Label>{t("role")}</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox aria-label={t("role")}>
          <ListBox.Item id={NO_ROLE} textValue={t("roleNone")}>
            {t("roleNone")}
            <ListBox.ItemIndicator />
          </ListBox.Item>
          {roles.map((role) => (
            <ListBox.Item key={role.id} id={role.id} textValue={role.label}>
              {role.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
      <Description>{t("roleHint")}</Description>
    </Select>
  );
}
