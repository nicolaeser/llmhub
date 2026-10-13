"use client";

import { useId, useState, useTransition } from "react";
import { Label, ListBox, Select } from "@heroui/react";
import { Coins, Database, Gauge, PiggyBank, Receipt, Sparkles } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import StatCard from "@/components/console/stat-card";
import { loadCacheStatsAction } from "../_action";
import { CACHE_STATS_RANGES } from "@/lib/gateway/cache/cache-settings";
import { isActionFail } from "@/lib/http/action-result";
import type { ResponseCacheStats } from "@/types/cache";
import { useErrorToast } from "@/components/console/use-error-toast";

export default function CacheStats({ initial, semanticOn }: { initial: ResponseCacheStats; semanticOn: boolean }) {
  const t = useTranslations("Settings.cache");
  const showError = useErrorToast();
  const format = useFormatter();
  const [stats, setStats] = useState(initial);
  const [pending, start] = useTransition();
  const headingId = useId();
  const showSemantic = semanticOn || stats.semanticHits > 0 || stats.lookupCost > 0;
  const tiles = [
    {
      key: "hitRate",
      label: t("stats.hitRate"),
      value: format.number(stats.hitRate, "percent"),
      icon: Gauge,
      tone: "accent" as const,
    },
    {
      key: "hits",
      label: t("stats.hits"),
      value: t("stats.hitsValue", { hits: stats.hits, lookups: stats.hits + stats.misses }),
      icon: Database,
      tone: "accent" as const,
    },
    {
      key: "netSaved",
      label: t("stats.netSaved"),
      value: format.number(stats.netSaved, "money"),
      icon: PiggyBank,
      tone: stats.netSaved > 0 ? ("success" as const) : ("accent" as const),
    },
    {
      key: "savedTokens",
      label: t("stats.savedTokens"),
      value: format.number(stats.savedTokens, "integer"),
      icon: Coins,
      tone: "success" as const,
    },
    ...(showSemantic
      ? [
          {
            key: "semanticHits",
            label: t("stats.semanticHits"),
            value: format.number(stats.semanticHits, "integer"),
            icon: Sparkles,
            tone: "accent" as const,
          },
          {
            key: "lookupCost",
            label: t("stats.lookupCost"),
            value: format.number(stats.lookupCost, "money"),
            icon: Receipt,
            tone: "warning" as const,
          },
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
              showError(result.error);
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
      <div aria-busy={pending} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map((tile) => (
          <StatCard key={tile.key} label={tile.label} value={tile.value} icon={tile.icon} tone={tile.tone} />
        ))}
      </div>
      <p className="text-xs text-muted">{t("stats.hint")}</p>
    </section>
  );
}
