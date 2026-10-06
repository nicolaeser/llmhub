"use client";

import { Chip } from "@heroui/react";
import { ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

export default function PiiChip({
  outcome,
  piiMode,
  piiInput,
  piiOutput,
}: {
  outcome: string;
  piiMode: string;
  piiInput: string[];
  piiOutput: string[];
}) {
  const t = useTranslations("Logs");
  const tPii = useTranslations("Guardrails");
  const format = useFormatter();
  const found = [...new Set([...piiInput, ...piiOutput])];
  const names = found.map((id) => tPii("entityLabel", { id }));
  const title = format.list(names, "enumeration");

  if (outcome === "pii_blocked") {
    return (
      <Chip size="sm" variant="soft" color="danger" title={title} className="whitespace-nowrap">
        <ShieldX size={14} aria-hidden />
        <Chip.Label>{t("pii.blocked")}</Chip.Label>
      </Chip>
    );
  }
  if (found.length) {
    return (
      <Chip size="sm" variant="soft" color="warning" title={title} className="whitespace-nowrap">
        <ShieldAlert size={14} aria-hidden />
        <Chip.Label>{t("pii.found", { entity: names[0] ?? "", more: found.length - 1 })}</Chip.Label>
      </Chip>
    );
  }
  if (piiMode) {
    return (
      <Chip size="sm" variant="soft" color="success" className="whitespace-nowrap">
        <ShieldCheck size={14} aria-hidden />
        <Chip.Label>{t("pii.clean")}</Chip.Label>
      </Chip>
    );
  }
  return <span className="text-muted">{t("pii.none")}</span>;
}
