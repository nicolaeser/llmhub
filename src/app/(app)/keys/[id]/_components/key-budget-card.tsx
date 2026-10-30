"use client";

import { Button, Label, Meter } from "@heroui/react";
import { Rocket, Wallet } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { budgetPeriod, meterColor } from "@/lib/utils/budget";
import type { BudgetView } from "@/types/structure";
import SectionCard, { Facts } from "./section-card";

export default function KeyBudgetCard({
  budget,
  now,
  canBudget,
  onBudget,
  onBoost,
}: {
  budget: Pick<BudgetView, "maxBudget" | "spend" | "budgetDuration"> & Partial<BudgetView>;
  now: Date;
  canBudget: boolean;
  onBudget: () => void;
  onBoost: () => void;
}) {
  const t = useTranslations("Keys.detail");
  const tBudgets = useTranslations("Budgets");
  const format = useFormatter();
  const boost = budget.boost ?? 0;
  const cap = budget.maxBudget > 0 ? budget.maxBudget + boost : 0;
  const ratio = cap > 0 ? Math.min(1, budget.spend / cap) : 0;
  const period = budgetPeriod(budget.budgetDuration) ?? "";
  const periodName = period === "1d" ? "daily" : period === "7d" ? "weekly" : period === "30d" ? "monthly" : period ? "custom" : "none";
  const resetsAt = budget.resetsAt ? new Date(budget.resetsAt) : null;

  return (
    <SectionCard
      title={t("budgetTitle")}
      description={t("budgetHint")}
      action={
        canBudget ? (
          <>
            {budget.maxBudget > 0 ? (
              <Button size="sm" variant="tertiary" onPress={onBoost}>
                <Rocket size={14} aria-hidden />
                {tBudgets("boost.action")}
              </Button>
            ) : null}
            <Button size="sm" variant="secondary" onPress={onBudget}>
              <Wallet size={14} aria-hidden />
              {t("setBudget", { capped: budget.maxBudget > 0 ? "yes" : "no" })}
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {cap > 0 ? (
          <Meter value={ratio * 100} color={meterColor(ratio)} aria-label={t("budgetUsed")}>
            <Label>{t("budgetSpent", { spend: budget.spend, cap })}</Label>
            <Meter.Output />
            <Meter.Track>
              <Meter.Fill />
            </Meter.Track>
          </Meter>
        ) : (
          <p className="text-sm text-muted">{t("noBudget", { spend: budget.spend })}</p>
        )}
        {budget.maxBudget > 0 ? (
          <Facts
            items={[
              { label: t("budgetLimit"), value: format.number(budget.maxBudget, "money") },
              {
                label: t("budgetPeriod"),
                value:
                  periodName === "custom"
                    ? tBudgets("periodCustom", { days: Number.parseInt(period, 10) })
                    : tBudgets("periods", { period: periodName }),
              },
              ...(resetsAt
                ? [{ label: t("budgetResets"), value: resetsAt > now ? format.dateTime(resetsAt, "stamp") : t("budgetResetsNow") }]
                : []),
              ...(boost > 0 ? [{ label: t("budgetBoost"), value: format.number(boost, "money") }] : []),
            ]}
          />
        ) : null}
      </div>
    </SectionCard>
  );
}
