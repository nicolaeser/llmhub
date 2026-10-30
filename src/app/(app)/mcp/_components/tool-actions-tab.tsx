"use client";

import { useState } from "react";
import { Alert, Button, Dropdown, SearchField, Table } from "@heroui/react";
import { Ban, Check, ChevronDown, CircleCheck, Minus, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import { isToolAction, roleAllowsTool, toolGrant } from "@/lib/mcp/resolve";
import { MCP_ACTIONS } from "@/schemas/mcp";
import type { McpRoleView, McpToolGrant, McpToolSpec } from "@/types/mcp";
import { toolMatches } from "./role-view";

const NEXT_GRANT = { inherit: "allow", allow: "deny", deny: "inherit" } as const satisfies Record<McpToolGrant, McpToolGrant>;
const UNCLASSIFIED = "none";
const SEARCH_FROM = 7;

export default function ToolActionsTab({
  tools,
  baseTools,
  roles,
  suggested,
  pending,
  roleLabel,
  onClassify,
  onAcceptHints,
  onGrant,
}: {
  tools: McpToolSpec[];
  baseTools: McpToolSpec[];
  roles: McpRoleView[];
  suggested: number;
  pending: boolean;
  roleLabel: (role: McpRoleView) => string;
  onClassify: (tool: McpToolSpec, value: string) => void;
  onAcceptHints: () => void;
  onGrant: (role: McpRoleView, tool: string, grant: McpToolGrant) => void;
}) {
  const t = useTranslations("Mcp");
  const tCommon = useTranslations("Common");
  const [query, setQuery] = useState("");
  const visible = tools.filter((tool) => toolMatches(tool, query));

  function actionMenu(tool: McpToolSpec) {
    const base = baseTools.find((item) => item.name === tool.name) ?? tool;
    const options = base.action ? [...MCP_ACTIONS] : [UNCLASSIFIED, ...MCP_ACTIONS];
    const value = tool.action ?? UNCLASSIFIED;
    return (
      <div className="space-y-1">
        <Dropdown>
          <Button size="sm" variant="tertiary" aria-label={t("permissions.classify", { tool: tool.name })} isDisabled={pending}>
            {tool.action ? t("action", { action: tool.action }) : t("permissions.unclassified")}
            <ChevronDown size={14} aria-hidden />
          </Button>
          <Dropdown.Popover>
            <Dropdown.Menu
              aria-label={t("permissions.classify", { tool: tool.name })}
              selectionMode="single"
              selectedKeys={[value]}
              onAction={(key) => onClassify(base, String(key))}
            >
              {options.map((option) => {
                const label = isToolAction(option) ? t("action", { action: option }) : t("permissions.unclassified");
                return (
                  <Dropdown.Item key={option} id={option} textValue={label}>
                    {label}
                    <Dropdown.ItemIndicator />
                  </Dropdown.Item>
                );
              })}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
        {base.hint && base.hint !== tool.action ? (
          <p className="text-xs text-muted">{t("permissions.serverHint", { action: base.hint })}</p>
        ) : null}
      </div>
    );
  }

  function grantButton(role: McpRoleView, tool: McpToolSpec, labeled: boolean) {
    const grant = toolGrant(role, tool.name);
    const granted = roleAllowsTool(role, tool);
    const icon =
      grant === "deny" ? (
        <Ban size={16} className="text-danger" aria-hidden />
      ) : grant === "allow" ? (
        <CircleCheck size={16} className="text-success" aria-hidden />
      ) : granted ? (
        <Check size={16} className="text-foreground" aria-hidden />
      ) : (
        <Minus size={16} className="text-muted" aria-hidden />
      );
    return (
      <Button
        key={role.id}
        isIconOnly={!labeled}
        size="sm"
        variant={labeled ? "secondary" : "ghost"}
        isDisabled={pending}
        aria-label={t("permissions.cell", { role: roleLabel(role), tool: tool.name, grant, granted: String(granted) })}
        onPress={() => onGrant(role, tool.name, NEXT_GRANT[grant])}
      >
        {icon}
        {labeled ? roleLabel(role) : null}
      </Button>
    );
  }

  if (tools.length === 0) {
    return (
      <Alert status="warning">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Description>{t("permissions.noTools")}</Alert.Description>
        </Alert.Content>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">{t("permissions.toolsHint")}</p>
      {suggested ? (
        <Alert status="accent">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{t("permissions.suggestions", { count: suggested })}</Alert.Description>
          </Alert.Content>
          <Button size="sm" variant="secondary" onPress={onAcceptHints} isDisabled={pending}>
            <Sparkles size={14} aria-hidden />
            {t("permissions.applySuggestions")}
          </Button>
        </Alert>
      ) : null}
      {tools.length >= SEARCH_FROM ? (
        <SearchField value={query} onChange={setQuery} aria-label={t("permissions.search")} className="w-full sm:max-w-xs">
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder={t("permissions.search")} />
            <SearchField.ClearButton aria-label={tCommon("close")} />
          </SearchField.Group>
        </SearchField>
      ) : null}
      {visible.length === 0 ? (
        <p className="text-sm text-muted">{t("permissions.noMatches")}</p>
      ) : (
        <>
          <RowCards label={t("permissions.matrixLabel")}>
            {visible.map((tool) => (
              <RowCard
                key={tool.name}
                variant="secondary"
                title={<span className="break-all">{tool.title || tool.name}</span>}
                description={tool.title ? <span className="font-mono text-xs break-all">{tool.name}</span> : undefined}
                details={[{ label: t("permissions.columnAction"), value: actionMenu(tool), wide: true }]}
                actions={roles.map((role) => grantButton(role, tool, true))}
              />
            ))}
          </RowCards>
          <Table aria-label={t("permissions.matrixLabel")} className={TABLE_FROM_LG}>
            <Table.ScrollContainer>
              <Table.Content className="min-w-xl">
                <Table.Header>
                  <Table.Column isRowHeader>{t("permissions.columnTool")}</Table.Column>
                  <Table.Column>{t("permissions.columnAction")}</Table.Column>
                  {roles.map((role) => (
                    <Table.Column key={role.id} id={role.id}>
                      {roleLabel(role)}
                    </Table.Column>
                  ))}
                </Table.Header>
                <Table.Body>
                  {visible.map((tool) => (
                    <Table.Row key={tool.name} id={tool.name}>
                      <Table.Cell>
                        <div className="min-w-0">
                          <p className="text-sm font-medium break-all">{tool.title || tool.name}</p>
                          {tool.title ? <p className="font-mono text-xs break-all text-muted">{tool.name}</p> : null}
                        </div>
                      </Table.Cell>
                      <Table.Cell>{actionMenu(tool)}</Table.Cell>
                      {roles.map((role) => (
                        <Table.Cell key={role.id}>{grantButton(role, tool, false)}</Table.Cell>
                      ))}
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
          <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted">
            <span className="flex items-center gap-1">
              <Check size={14} className="text-foreground" aria-hidden />
              {t("permissions.legend", { kind: "inherited" })}
            </span>
            <span className="flex items-center gap-1">
              <CircleCheck size={14} className="text-success" aria-hidden />
              {t("permissions.legend", { kind: "allowed" })}
            </span>
            <span className="flex items-center gap-1">
              <Ban size={14} className="text-danger" aria-hidden />
              {t("permissions.legend", { kind: "denied" })}
            </span>
            <span className="flex items-center gap-1">
              <Minus size={14} className="text-muted" aria-hidden />
              {t("permissions.legend", { kind: "none" })}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
