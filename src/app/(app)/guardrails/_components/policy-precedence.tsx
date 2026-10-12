"use client";

import { Card } from "@heroui/react";
import { useTranslations } from "next-intl";

const PRECEDENCE = ["key", "project", "org", "global"] as const;

export default function PolicyPrecedence({ note }: { note: string }) {
  const t = useTranslations("Guardrails");

  return (
    <>
      <ol className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label={t("precedence.title")}>
        {PRECEDENCE.map((level, index) => (
          <li key={level}>
            <Card variant="secondary" className="h-full gap-1">
              <span className="text-xs tabular-nums text-muted">{t("precedence.number", { n: index + 1 })}</span>
              <p className="text-sm font-medium">{t(`precedence.${level}.title`)}</p>
              <p className="text-xs text-muted">{t(`precedence.${level}.hint`)}</p>
            </Card>
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted">{note}</p>
    </>
  );
}
