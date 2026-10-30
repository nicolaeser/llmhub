"use client";

import { useFormatter, useTranslations } from "next-intl";
import type { ModelPolicy, TemplateProviderOption, TemplateRules } from "@/types/model-templates";
import { presetSummary, type PresetCondition, type PresetSummary } from "./preset-summary";

export type PresetSummaryText = { summary: PresetSummary; sentence: string };

export function usePresetSummary(
  policies: ModelPolicy[],
  providers: readonly TemplateProviderOption[],
): (rules: TemplateRules) => PresetSummaryText {
  const t = useTranslations("ModelTemplates");
  const format = useFormatter();

  function condition(item: PresetCondition) {
    if (item.kind === "regions") {
      return t("condition", {
        kind: item.kind,
        regions: format.list(
          item.regions.map((region) => t("region", { region })),
          { type: "disjunction" },
        ),
      });
    }
    if (item.kind === "patterns") {
      return t("condition", { kind: item.kind, patterns: format.list(item.patterns, { type: "disjunction" }) });
    }
    if (item.kind === "retention") return t("condition", { kind: item.kind, days: item.days });
    if (item.kind === "picked") return t("condition", { kind: item.kind, count: item.count });
    return t("condition", { kind: item.kind });
  }

  return (rules) => {
    const summary = presetSummary(rules, policies, providers);
    const listed = summary.conditions.filter((item) => item.kind !== "picked");
    const picked = summary.conditions.find((item) => item.kind === "picked");
    const sentence = t("summary", {
      mode: summary.mode,
      count: summary.matches.length,
      scoped: String(summary.providers.length > 0),
      providers: format.list(summary.providers, { type: "conjunction" }),
      limited: String(listed.length > 0),
      conditions: format.list(listed.map(condition), { type: "conjunction" }),
      picked: picked?.kind === "picked" ? picked.count : 0,
    });
    return { summary, sentence };
  };
}
