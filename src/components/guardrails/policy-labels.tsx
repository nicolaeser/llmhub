"use client";

import { Chip } from "@heroui/react";
import { useFormatter, useTranslations } from "next-intl";
import type { PolicyRef, SectionState, SectionSummary } from "@/types/guardrails";

const STATE_COLORS: Partial<Record<SectionState, "success" | "warning" | "accent">> = {
  mask: "success",
  block: "success",
  restore: "success",
  flag: "warning",
  on: "accent",
};

function useStateLabel() {
  const t = useTranslations("Guardrails");
  return (summary: SectionSummary) =>
    summary.section === "rules"
      ? t("rules.count", { count: summary.count })
      : t("sectionState", { state: summary.state });
}

function useDetailLabel() {
  const t = useTranslations("Guardrails");
  return (summary: SectionSummary) =>
    summary.section === "rules" || summary.state === "off"
      ? null
      : t("sectionDetail", { section: summary.section, count: summary.count });
}

export function SectionChip({ summary }: { summary: SectionSummary }) {
  const stateLabel = useStateLabel();
  return (
    <Chip size="sm" variant="soft" color={STATE_COLORS[summary.state]}>
      {stateLabel(summary)}
    </Chip>
  );
}

export function SectionDetail({ summary }: { summary: SectionSummary }) {
  const detailLabel = useDetailLabel();
  const detail = detailLabel(summary);
  if (!detail) return null;
  return <span className="text-xs text-muted">{detail}</span>;
}

export function useSectionText() {
  const format = useFormatter();
  const stateLabel = useStateLabel();
  const detailLabel = useDetailLabel();
  return (summary: SectionSummary) => {
    const detail = detailLabel(summary);
    return detail ? format.list([stateLabel(summary), detail], { type: "unit" }) : stateLabel(summary);
  };
}

export function useSourceLabel(aliasOf: (ref: PolicyRef) => string | undefined) {
  const t = useTranslations("Guardrails");
  return (ref: PolicyRef | null) =>
    ref
      ? t("source", { scope: ref.scope, alias: aliasOf(ref) ?? t("unknownTarget") })
      : t("source", { scope: "platform", alias: "" });
}
