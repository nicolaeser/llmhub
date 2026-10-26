"use client";

import { Chip } from "@heroui/react";
import {
  Building2,
  Fingerprint,
  Folder,
  Globe,
  KeyRound,
  ListFilter,
  LockKeyhole,
  ShieldAlert,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import type { PolicyRef, PolicyScope, PolicySection, SectionState, SectionSummary } from "@/types/guardrails";

export type PolicyLevel = PolicyScope | "platform";

export const LEVEL_ICONS: Record<PolicyLevel, LucideIcon> = {
  platform: Globe,
  org: Building2,
  team: Users,
  project: Folder,
  key: KeyRound,
};

export const SECTION_ICONS: Record<PolicySection, LucideIcon> = {
  pii: Fingerprint,
  injection: ShieldAlert,
  secrets: LockKeyhole,
  rules: ListFilter,
};

const STATE_COLORS: Partial<Record<SectionState, "success" | "warning" | "accent">> = {
  mask: "success",
  block: "success",
  restore: "success",
  flag: "warning",
  on: "accent",
};

export function SectionChip({ summary }: { summary: SectionSummary }) {
  const t = useTranslations("Guardrails");
  const label =
    summary.section === "rules"
      ? t("rules.count", { count: summary.count })
      : t("sectionState", { state: summary.state });
  return (
    <Chip size="sm" variant="soft" color={STATE_COLORS[summary.state]}>
      {label}
    </Chip>
  );
}

export function SectionDetail({ summary }: { summary: SectionSummary }) {
  const t = useTranslations("Guardrails");
  if (summary.section === "rules" || summary.state === "off") return null;
  return <span className="text-xs text-muted">{t("sectionDetail", { section: summary.section, count: summary.count })}</span>;
}

export function useSourceLabel(aliasOf: (ref: PolicyRef) => string | undefined) {
  const t = useTranslations("Guardrails");
  return (ref: PolicyRef | null) =>
    ref
      ? t("source", { scope: ref.scope, alias: aliasOf(ref) ?? t("unknownTarget") })
      : t("source", { scope: "platform", alias: "" });
}
