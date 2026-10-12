"use client";

import { Chip } from "@heroui/react";
import { useTranslations } from "next-intl";
import { parseHit } from "@/lib/gateway/guardrails";

export function useGuardrailHitLabel(): (hit: string) => string {
  const t = useTranslations("Guardrails");
  return (hit) => {
    const { kind, value } = parseHit(hit);
    const label =
      kind === "injection"
        ? t("injection.check", { check: value })
        : kind === "secret"
          ? t("entityLabel", { id: value })
          : value;
    return t("hitLabel", { kind, label });
  };
}

export default function GuardrailHit({ hit }: { hit: string }) {
  const label = useGuardrailHitLabel();
  return (
    <Chip size="sm" variant="soft" color="warning">
      {label(hit)}
    </Chip>
  );
}
