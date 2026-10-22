"use client";

import { Chip } from "@heroui/react";
import { useTranslations } from "next-intl";
import { splitPiiPlaceholders } from "@/lib/gateway/safety/pii";

export function PiiPlaceholder({ token, entity, number }: { token: string; entity: string; number: number | null }) {
  const t = useTranslations("Logs.detail");
  const tPii = useTranslations("Guardrails");
  return (
    <Chip size="sm" variant="soft" color="warning" title={token}>
      {t("placeholder", { label: tPii("entityLabel", { id: entity }), number: number ?? 0 })}
    </Chip>
  );
}

export function PiiCode({ text }: { text: string }) {
  return (
    <pre className="font-mono text-xs break-all whitespace-pre-wrap">
      {splitPiiPlaceholders(text).map((part, index) =>
        part.entity ? (
          <Chip key={index} size="sm" variant="soft" color="warning">
            {part.text}
          </Chip>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </pre>
  );
}
