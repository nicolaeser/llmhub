"use client";

import { Card } from "@heroui/react";
import { useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
import type { PolicyScope } from "@/types/guardrails";
import { LEVEL_ICONS, type PolicyLevel } from "@/components/guardrails/policy-labels";

const LEVELS: readonly PolicyLevel[] = ["platform", "org", "team", "project", "key"];

export default function PolicyChain({ counts }: { counts: Record<PolicyScope, number> }) {
  const t = useTranslations("Guardrails");

  return (
    <Card className="gap-4">
      <Card.Header>
        <Card.Title>{t("chain.title")}</Card.Title>
        <Card.Description>{t("chain.hint")}</Card.Description>
      </Card.Header>
      <Card.Content>
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5" aria-label={t("chain.title")}>
          {LEVELS.map((level, index) => {
            const count = level === "platform" ? 0 : counts[level];
            return (
              <li key={level} className="min-w-0">
                <Card variant="secondary" className="h-full gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <IconTile
                      icon={LEVEL_ICONS[level]}
                      size="sm"
                      tone={level === "platform" || count > 0 ? "accent" : "neutral"}
                    />
                    <span className="text-xs tabular-nums text-muted">{t("chain.step", { n: index + 1 })}</span>
                  </div>
                  <p className="text-sm font-medium">{t("scopeLabel", { scope: level })}</p>
                  <p className="text-xs text-muted">{t("chain.levelHint", { level })}</p>
                  <p className="mt-auto text-xs font-medium">
                    {level === "platform" ? t("chain.always") : t("chain.count", { count })}
                  </p>
                </Card>
              </li>
            );
          })}
        </ol>
      </Card.Content>
    </Card>
  );
}
