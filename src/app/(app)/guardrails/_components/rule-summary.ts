"use client";

import { useFormatter, useTranslations } from "next-intl";
import type { GuardrailRule } from "@/types/guardrails";
import { previewTerms } from "./rule-view";

export function useRuleSummary(): (rule: GuardrailRule) => string {
  const t = useTranslations("Guardrails.rules");
  const format = useFormatter();
  return (rule) => {
    const { shown, more } = previewTerms(rule);
    if (!shown.length) return t("summaryEmpty");
    const items = [...shown.map((term) => t("term", { term })), ...(more ? [t("more", { count: more })] : [])];
    return t("summary", {
      action: rule.action,
      target: rule.target,
      kind: rule.kind,
      patterns: format.list(items, { type: "disjunction" }),
    });
  };
}
