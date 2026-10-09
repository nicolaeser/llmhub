"use client";

import { useId, useState, useTransition } from "react";
import { Label, ListBox, Select, toast } from "@heroui/react";
import { useFormatter, useTranslations } from "next-intl";
import StatCard from "@/components/console/stat-card";
import { loadCacheStatsAction } from "@/app/(app)/cache/_action";
import { CACHE_STATS_RANGES } from "@/lib/gateway/cache-settings";
import { isActionFail } from "@/lib/http/action-result";
import type { ResponseCacheStats } from "@/types/cache";

export default function CacheStats({ initial, semanticOn }: { initial: ResponseCacheStats; semanticOn: boolean }) {
  const t = useTranslations("Cache");
  const tError = useTranslations("Error");
  const format = useFormatter();
  const [stats, setStats] = useState(initial);
  const [pending, start] = useTransition();
  const headingId = useId();
  const showSemantic = semanticOn || stats.semanticHits > 0 || stats.lookupCost > 0;
  const tiles = [
    { key: "hitRate", label: t("stats.hitRate"), value: format.number(stats.hitRate, "percent") },
    {
      key: "hits",
      label: t("stats.hits"),
      value: t("stats.hitsValue", { hits: stats.hits, lookups: stats.hits + stats.misses }),
    },
    { key: "netSaved", label: t("stats.netSaved"), value: format.number(stats.netSaved, "money") },
    { key: "savedTokens", label: t("stats.savedTokens"), value: format.number(stats.savedTokens, "integer") },
    ...(showSemantic
      ? [
          {
            key: "semanticHits",
            label: t("stats.semanticHits"),
            value: format.number(stats.semanticHits, "integer"),
          },
          { key: "lookupCost", label: t("stats.lookupCost"), value: format.number(stats.lookupCost, "money") },
        ]
      : []),
  ];

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2 id={headingId} className="text-sm font-medium">
        {t("stats.title")}
      </h2>
      <Select
        selectedKey={String(stats.days)}
        onSelectionChange={(key) => {
          const days = Number(key);
          start(async () => {
            const result = await loadCacheStatsAction({ days });
            if (isActionFail(result)) {
              toast.danger(tError("code", { code: result.error }));
              return;
            }
            setStats(result);
          });
        }}
        aria-label={t("stats.range")}
        className="max-w-xs"
        fullWidth
      >
        <Label>{t("stats.range")}</Label>
        <Select.Trigger>
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover>
          <ListBox aria-label={t("stats.range")}>
            {CACHE_STATS_RANGES.map((n) => (
              <ListBox.Item key={String(n)} id={String(n)} textValue={t("stats.days", { n })}>
                {t("stats.days", { n })}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
      <div aria-busy={pending} className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {tiles.map((tile) => (
          <StatCard key={tile.key} label={tile.label} value={tile.value} />
        ))}
      </div>
      <p className="text-xs text-muted">{t("stats.hint")}</p>
    </section>
  );
}
