"use client";

import { Fragment, useState } from "react";
import {
  Button,
  Card,
  Chip,
  Description,
  Input,
  Label,
  SearchField,
  Separator,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
} from "@heroui/react";
import { ArrowLeft, RotateCcw, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { roleAllowsTool, toolGrant } from "@/lib/mcp/resolve";
import { MCP_ACTIONS } from "@/schemas/mcp";
import type { McpRoleView, McpToolGrant, McpToolSpec } from "@/types/mcp";
import { toolMatches, withGrant } from "./role-view";

const GRANTS = ["inherit", "allow", "deny"] as const satisfies readonly McpToolGrant[];
const SEARCH_FROM = 7;

export default function RoleEditor({
  role,
  label,
  tools,
  pending,
  onChange,
  onRemove,
  onBack,
}: {
  role: McpRoleView;
  label: string;
  tools: McpToolSpec[];
  pending: boolean;
  onChange: (change: Partial<McpRoleView>) => void;
  onRemove: () => void;
  onBack: () => void;
}) {
  const t = useTranslations("Mcp");
  const tCommon = useTranslations("Common");
  const [query, setQuery] = useState("");
  const visible = tools.filter((tool) => toolMatches(tool, query));
  const granted = tools.filter((tool) => roleAllowsTool(role, tool)).length;

  return (
    <div className="space-y-5">
      <Button size="sm" variant="ghost" className="self-start" onPress={onBack} isDisabled={pending || !role.name.trim()}>
        <ArrowLeft size={14} aria-hidden />
        {t("permissions.backToRoles")}
      </Button>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          fullWidth
          isRequired
          value={role.builtin ? label : role.name}
          onChange={(name) => onChange({ name })}
          isDisabled={role.builtin || pending}
        >
          <Label>{t("permissions.name")}</Label>
          <Input />
          <Description>
            {role.builtin ? t("permissions.builtinHint") : t("permissions.assigned", { count: role.assigned })}
          </Description>
        </TextField>
        <TextField fullWidth value={role.description} onChange={(description) => onChange({ description })} isDisabled={pending}>
          <Label>{t("permissions.roleDescription")}</Label>
          <Input />
        </TextField>
      </div>

      <div className="space-y-3">
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">{t("permissions.baseline")}</p>
          <p className="text-sm text-muted">{t("permissions.baselineHint")}</p>
        </div>
        <ToggleButtonGroup
          selectionMode="multiple"
          aria-label={t("permissions.actions")}
          selectedKeys={role.allActions ? [...MCP_ACTIONS] : role.actions}
          onSelectionChange={(keys) => onChange({ actions: MCP_ACTIONS.filter((action) => keys.has(action)) })}
          isDisabled={pending || role.allActions}
        >
          {MCP_ACTIONS.map((action, index) => (
            <ToggleButton key={action} id={action}>
              {index > 0 ? <ToggleButtonGroup.Separator /> : null}
              {t("action", { action })}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <Switch isSelected={role.allActions} onChange={(allActions) => onChange({ allActions })} isDisabled={pending}>
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            <Label>{t("permissions.allActions")}</Label>
          </Switch.Content>
          <Description>{t("permissions.allActionsHint")}</Description>
        </Switch>
      </div>

      <Separator />

      <div className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
              {t("permissions.perTool")}
              <Chip size="sm" variant="soft">
                {t("permissions.grantedCount", { granted, count: tools.length })}
              </Chip>
            </p>
            <p className="text-sm text-muted">{t("permissions.perToolHint")}</p>
          </div>
          {role.tools.length || role.deniedTools.length ? (
            <Button size="sm" variant="tertiary" onPress={() => onChange({ tools: [], deniedTools: [] })} isDisabled={pending}>
              <RotateCcw size={14} aria-hidden />
              {t("permissions.resetTools")}
            </Button>
          ) : null}
        </div>
        {tools.length >= SEARCH_FROM ? (
          <SearchField value={query} onChange={setQuery} aria-label={t("permissions.search")} className="w-full sm:max-w-xs">
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input placeholder={t("permissions.search")} />
              <SearchField.ClearButton aria-label={tCommon("close")} />
            </SearchField.Group>
          </SearchField>
        ) : null}
        {tools.length === 0 ? (
          <p className="text-sm text-muted">{t("permissions.noTools")}</p>
        ) : visible.length === 0 ? (
          <p className="text-sm text-muted">{t("permissions.noMatches")}</p>
        ) : (
          <Card variant="secondary" className="gap-0">
            {visible.map((tool, index) => {
              const grant = toolGrant(role, tool.name);
              const allowed = roleAllowsTool(role, tool);
              return (
                <Fragment key={tool.name}>
                  {index > 0 ? <Separator /> : null}
                  <div className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 md:flex-row md:items-center md:justify-between">
                    <div className="min-w-0 space-y-1 md:flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium break-all text-foreground">{tool.title || tool.name}</span>
                        <Chip size="sm" variant="soft" color={allowed ? "success" : "default"}>
                          {t("permissions.effect", { granted: String(allowed) })}
                        </Chip>
                      </div>
                      <p className="text-xs break-all text-muted">
                        {tool.action ? t("action", { action: tool.action }) : t("permissions.unclassified")}
                        {tool.title ? ` · ${tool.name}` : ""}
                      </p>
                    </div>
                    <ToggleButtonGroup
                      size="sm"
                      selectionMode="single"
                      disallowEmptySelection
                      aria-label={t("permissions.grantLabel", { tool: tool.name })}
                      selectedKeys={[grant]}
                      onSelectionChange={(keys) => {
                        const next = GRANTS.find((item) => item === [...keys][0]);
                        if (next) onChange(withGrant(role, tool.name, next));
                      }}
                      isDisabled={pending}
                    >
                      {GRANTS.map((item, position) => (
                        <ToggleButton key={item} id={item}>
                          {position > 0 ? <ToggleButtonGroup.Separator /> : null}
                          {t("permissions.grant", { grant: item })}
                        </ToggleButton>
                      ))}
                    </ToggleButtonGroup>
                  </div>
                </Fragment>
              );
            })}
          </Card>
        )}
      </div>

      {role.builtin ? null : (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="danger-soft" onPress={onRemove} isDisabled={pending || role.assigned > 0}>
            <Trash2 size={14} aria-hidden />
            {t("permissions.delete")}
          </Button>
          {role.assigned > 0 ? <p className="text-sm text-muted">{t("permissions.deleteBlocked")}</p> : null}
        </div>
      )}
    </div>
  );
}
