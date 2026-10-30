"use client";

import { Meter } from "@heroui/react";
import { useFormatter, useTranslations } from "next-intl";
import { budgetRatio } from "@/lib/tenancy/company-view";
import { meterColor } from "@/lib/utils/budget";
import type { BudgetView } from "@/types/structure";

const RATIO_TEXT = { accent: "text-muted", warning: "text-warning", danger: "text-danger" } as const;

export default function SpendMeter({ budget, label }: { budget: BudgetView; label: string }) {
  const t = useTranslations("Companies.meter");
  const format = useFormatter();
  const ratio = budgetRatio(budget);

  if (ratio === null) {
    return <p className="text-sm text-muted tabular-nums">{t("noCap", { spend: budget.spend })}</p>;
  }

  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
        <span className="text-foreground tabular-nums">
          {t("spendOf", { spend: budget.spend, cap: budget.maxBudget + budget.boost })}
        </span>
        <span className={`tabular-nums ${RATIO_TEXT[meterColor(ratio)]}`}>{format.number(ratio, "percent")}</span>
      </div>
      <Meter size="sm" value={ratio * 100} color={meterColor(ratio)} aria-label={label}>
        <Meter.Track>
          <Meter.Fill />
        </Meter.Track>
      </Meter>
    </div>
  );
}
