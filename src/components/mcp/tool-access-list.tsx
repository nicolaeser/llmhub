"use client";

import { useState } from "react";
import { Alert, Button, Chip, SearchField, Switch } from "@heroui/react";
import { RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import { grantAllows, withToolVisible } from "@/lib/mcp/resolve";
import type { McpAccessGrant, McpCeiling, McpToolSpec } from "@/types/mcp";
import { actionColor } from "./access-labels";

const SEARCH_FROM = 6;

type ToolNote = "extra" | "hidden" | "above" | "plain";

function noteOf(grant: McpAccessGrant, tool: McpToolSpec, ceiling: McpCeiling | null): ToolNote {
  if (grant.blockedTools.includes(tool.name)) return "hidden";
  if (grant.access !== "inherit" && grant.extraTools.includes(tool.name)) return "extra";
  if (ceiling && !ceiling.allows(tool)) return "above";
  return "plain";
}

function matches(tool: McpToolSpec, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [tool.name, tool.title, tool.description].some((value) => value.toLowerCase().includes(needle));
}

export default function ToolAccessList({
  tools,
  grant,
  ceiling = null,
  onChange,
  isDisabled,
}: {
  tools: McpToolSpec[];
  grant: McpAccessGrant;
  ceiling?: McpCeiling | null;
  onChange: (next: Pick<McpAccessGrant, "extraTools" | "blockedTools">) => void;
  isDisabled?: boolean;
}) {
  const t = useTranslations("Mcp.access");
  const tMcp = useTranslations("Mcp");
  const tCommon = useTranslations("Common");
  const [query, setQuery] = useState("");
  const shown = tools.filter((tool) => matches(tool, query));
  const on = tools.filter((tool) => grantAllows(grant, tool) && (!ceiling || ceiling.allows(tool))).length;
  const unclassified = grant.access !== "all" && grant.access !== "inherit" ? tools.filter((tool) => !tool.action).length : 0;
  const changed = grant.extraTools.length > 0 || grant.blockedTools.length > 0;

  if (!tools.length) return <p className="text-sm text-muted">{t("noTools")}</p>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
            {t("tools")}
            <Chip size="sm" variant="soft">
              {t("toolsCount", { on, total: tools.length })}
            </Chip>
          </p>
          <p className="text-sm text-muted">{t("toolsHint", { access: grant.access })}</p>
        </div>
        {changed ? (
          <Button size="sm" variant="tertiary" onPress={() => onChange({ extraTools: [], blockedTools: [] })} isDisabled={isDisabled}>
            <RotateCcw size={14} aria-hidden />
            {t("reset")}
          </Button>
        ) : null}
      </div>
      {unclassified ? (
        <Alert status="accent">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{t("unclassifiedNote", { count: unclassified })}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {tools.length >= SEARCH_FROM ? (
        <SearchField value={query} onChange={setQuery} aria-label={t("search")} className="w-full sm:max-w-xs">
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder={t("search")} />
            <SearchField.ClearButton aria-label={tCommon("close")} />
          </SearchField.Group>
        </SearchField>
      ) : null}
      {shown.length === 0 ? (
        <p className="text-sm text-muted">{t("noMatches")}</p>
      ) : (
        <ul aria-label={t("tools")} className="flex flex-col divide-y divide-border">
          {shown.map((tool) => {
            const allowed = grantAllows(grant, tool);
            const note = noteOf(grant, tool, ceiling);
            const label = tool.title || tool.name;
            return (
              <li key={tool.name} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium break-all text-foreground">{label}</span>
                    <Chip size="sm" variant="soft" color={actionColor(tool.action)}>
                      {tool.action ? tMcp("action", { action: tool.action }) : t("unclassified")}
                    </Chip>
                  </div>
                  {tool.title ? <p className="font-mono text-xs break-all text-muted">{tool.name}</p> : null}
                  {note === "plain" ? null : (
                    <p className={note === "above" ? "text-xs text-muted" : "text-xs text-accent"}>{t("toolNote", { state: note })}</p>
                  )}
                </div>
                <Switch
                  size="sm"
                  isSelected={allowed}
                  isDisabled={isDisabled}
                  aria-label={t("toolVisible", { name: label })}
                  onChange={(visible) => onChange(withToolVisible(grant, tool, visible))}
                >
                  <Switch.Content>
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                  </Switch.Content>
                </Switch>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
