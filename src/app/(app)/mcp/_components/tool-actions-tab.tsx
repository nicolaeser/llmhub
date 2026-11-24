"use client";

import { useState } from "react";
import { Alert, Button, Dropdown, SearchField, Table } from "@heroui/react";
import { ChevronDown, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import { isToolAction } from "@/lib/mcp/resolve";
import { MCP_ACTIONS } from "@/schemas/mcp";
import type { McpToolSpec } from "@/types/mcp";

const UNCLASSIFIED = "none";
const SEARCH_FROM = 6;

function toolMatches(tool: McpToolSpec, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return tool.name.toLowerCase().includes(needle) || tool.title.toLowerCase().includes(needle);
}

export default function ToolActionsTab({
  tools,
  baseTools,
  suggested,
  pending,
  onClassify,
  onAcceptHints,
}: {
  tools: McpToolSpec[];
  baseTools: McpToolSpec[];
  suggested: number;
  pending: boolean;
  onClassify: (tool: McpToolSpec, value: string) => void;
  onAcceptHints: () => void;
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
              />
            ))}
          </RowCards>
          <Table aria-label={t("permissions.matrixLabel")} className={TABLE_FROM_LG}>
            <Table.ScrollContainer>
              <Table.Content className="min-w-md">
                <Table.Header>
                  <Table.Column isRowHeader>{t("permissions.columnTool")}</Table.Column>
                  <Table.Column>{t("permissions.columnAction")}</Table.Column>
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
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        </>
      )}
    </div>
  );
}
