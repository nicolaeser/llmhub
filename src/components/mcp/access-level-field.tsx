"use client";

import { Alert, Description, Label, Switch } from "@heroui/react";
import { useTranslations } from "next-intl";
import ChoiceCards from "@/components/console/choice-cards";
import { levelRank } from "@/lib/mcp/resolve";
import { MCP_ACCESS_LEVELS } from "@/schemas/mcp";
import type { McpAccessLevel, McpRuleAccess } from "@/types/mcp";

export default function AccessLevelField({
  value,
  onChange,
  context,
  fallback = "read",
  ceiling,
  ceilingSource,
  isDisabled,
}: {
  value: McpRuleAccess;
  onChange: (next: McpRuleAccess) => void;
  context: "default" | "rule";
  fallback?: McpAccessLevel;
  ceiling?: McpAccessLevel | null;
  ceilingSource?: string;
  isDisabled?: boolean;
}) {
  const t = useTranslations("Mcp.access");
  const own = value !== "inherit";
  const limited = own && ceiling && ceilingSource && levelRank(value) > levelRank(ceiling);

  return (
    <div className="space-y-3">
      {context === "rule" ? (
        <Switch isSelected={own} onChange={(next) => onChange(next ? fallback : "inherit")} isDisabled={isDisabled}>
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            <Label>{t("own")}</Label>
          </Switch.Content>
          <Description>{t("ownHint", { own: String(own) })}</Description>
        </Switch>
      ) : null}
      {own ? (
        <ChoiceCards
          label={t("levelLabel")}
          value={value}
          columns={2}
          options={MCP_ACCESS_LEVELS.map((level) => ({
            id: level,
            label: t("level", { access: level }),
            hint: t("levelHint", { access: level, context }),
          }))}
          onChange={onChange}
          isDisabled={isDisabled}
        />
      ) : null}
      {limited ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>
              {t("limited", { level: t("level", { access: ceiling }), source: ceilingSource })}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
    </div>
  );
}
