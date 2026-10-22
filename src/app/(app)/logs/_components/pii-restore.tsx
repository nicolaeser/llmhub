"use client";

import { Chip } from "@heroui/react";
import { useTranslations } from "next-intl";
import { piiPlaceholderGroups } from "@/lib/gateway/safety/pii";
import type { PiiRestoreSummary } from "@/types/logs";

const RESTORE_SITES = ["text", "tools"] as const;

export default function PiiRestore({ restore }: { restore: PiiRestoreSummary }) {
  const t = useTranslations("Logs.detail");
  const tPii = useTranslations("Guardrails");
  const sites = RESTORE_SITES.filter((site) => restore[site].length);
  return (
    <dl className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
      <div className="min-w-0 space-y-2">
        <dt className="text-xs text-muted">{t("placeholders")}</dt>
        {piiPlaceholderGroups(restore.placeholders).map((group) => (
          <dd key={group.entity} className="flex flex-wrap items-center gap-2">
            <Chip size="sm" variant="soft">
              {t("placeholderGroup", { label: tPii("entityLabel", { id: group.entity }), count: group.tokens.length })}
            </Chip>
            <span className="font-mono text-xs break-words text-muted">{group.tokens.join(" ")}</span>
          </dd>
        ))}
      </div>
      <div className="min-w-0 space-y-2">
        <dt className="text-xs text-muted">{t("restored")}</dt>
        <dd>
          <Chip size="sm" variant="soft" color={sites.length ? "success" : "default"}>
            {t("restoredState", { state: sites.length ? "restored" : "unused" })}
          </Chip>
        </dd>
        {sites.map((site) => (
          <dd key={site} className="text-sm break-words">
            <span className="text-muted">{t("restoredSite", { site })}</span>{" "}
            <span className="font-mono text-xs">{restore[site].join(" ")}</span>
          </dd>
        ))}
      </div>
    </dl>
  );
}
