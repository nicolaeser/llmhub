"use client";

import { useFormatter, useTranslations } from "next-intl";
import type { McpAccessGrant, McpAccessSource, McpRuleAccess, McpToolAction } from "@/types/mcp";

type ChipColor = "default" | "accent" | "success" | "warning" | "danger";

const LEVEL_COLORS: Record<McpRuleAccess, ChipColor> = {
  inherit: "default",
  none: "danger",
  read: "success",
  write: "warning",
  all: "accent",
};

const ACTION_COLORS: Record<McpToolAction, ChipColor> = {
  read: "success",
  write: "warning",
  delete: "danger",
};

export function levelColor(access: McpRuleAccess): ChipColor {
  return LEVEL_COLORS[access];
}

export function actionColor(action: McpToolAction | undefined): ChipColor {
  return action ? ACTION_COLORS[action] : "default";
}

export function useAccessLabels() {
  const t = useTranslations("Mcp.access");
  const tAssign = useTranslations("Mcp.assign");
  const format = useFormatter();

  function level(grant: Pick<McpAccessGrant, "access" | "extraTools">): string {
    if (grant.access === "none" && grant.extraTools.length) return t("onlySelected", { count: grant.extraTools.length });
    return t("level", { access: grant.access });
  }

  function exceptions(grant: McpAccessGrant): string {
    const parts = [
      grant.access !== "none" && grant.extraTools.length ? t("extra", { count: grant.extraTools.length }) : "",
      grant.blockedTools.length ? t("hidden", { count: grant.blockedTools.length }) : "",
    ].filter(Boolean);
    return parts.length ? format.list(parts, { type: "unit" }) : "";
  }

  function summary(grant: McpAccessGrant): string {
    const extra = exceptions(grant);
    return extra ? `${level(grant)} · ${extra}` : level(grant);
  }

  function source(from: McpAccessSource): string {
    if (from.kind === "default") return t("defaultSource");
    return tAssign("source", { scope: from.rule.scope, label: from.rule.label });
  }

  return { level, exceptions, summary, source };
}
