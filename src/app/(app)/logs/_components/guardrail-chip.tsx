"use client";

import { Chip } from "@heroui/react";
import { ShieldAlert, ShieldX } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useGuardrailHitLabel } from "@/components/guardrails/guardrail-hit";

export default function GuardrailChip({
  outcome,
  guardInput,
  guardOutput,
}: {
  outcome: string;
  guardInput: string[];
  guardOutput: string[];
}) {
  const t = useTranslations("Logs");
  const format = useFormatter();
  const label = useGuardrailHitLabel();
  const hits = [...new Set([...guardInput, ...guardOutput])];
  const title = format.list(hits.map(label), "enumeration");

  if (outcome === "guardrail_blocked") {
    return (
      <Chip size="sm" variant="soft" color="danger" title={title} className="whitespace-nowrap">
        <ShieldX size={14} aria-hidden />
        <Chip.Label>{t("guard.blocked")}</Chip.Label>
      </Chip>
    );
  }
  if (!hits.length) return null;
  return (
    <Chip size="sm" variant="soft" color="warning" title={title} className="whitespace-nowrap">
      <ShieldAlert size={14} aria-hidden />
      <Chip.Label>{t("guard.flagged", { count: hits.length })}</Chip.Label>
    </Chip>
  );
}
