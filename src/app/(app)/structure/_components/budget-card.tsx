"use client";

import { Alert, Button, Card, Label, Meter } from "@heroui/react";
import { Wallet, Zap } from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { headroom, meterColor } from "@/lib/utils/budget";
import type { BudgetView, CapLink } from "@/types/structure";
import { usedRatio } from "./tree-model";

export default function BudgetCard({
  chain,
  budget,
  canBudget,
  onEdit,
  onBoost,
}: {
  chain: CapLink[];
  budget: BudgetView;
  canBudget: boolean;
  onEdit: () => void;
  onBoost: () => void;
}) {
  const t = useTranslations("Structure.budget");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const ratio = usedRatio(budget);
  const capped = budget.maxBudget > 0;
  const own = chain[0];
  const binding = headroom(chain);
  const limitedBy = binding && own && binding.link.kind !== own.kind ? binding : null;
  const resetsAt = budget.resetsAt ? new Date(budget.resetsAt) : null;

  return (
    <Card>
      <Card.Header className="flex-row flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Card.Title>{t("title")}</Card.Title>
          <Card.Description>
            {resetsAt
              ? t("resets", { when: resetsAt > now ? "later" : "now", date: resetsAt })
              : t("noReset")}
          </Card.Description>
        </div>
        {canBudget ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onPress={onEdit}>
              <Wallet size={14} aria-hidden />
              {t("edit", { capped: capped ? "yes" : "no" })}
            </Button>
            {capped ? (
              <Button size="sm" variant="tertiary" onPress={onBoost}>
                <Zap size={14} aria-hidden />
                {t("boost")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </Card.Header>
      <Card.Content className="space-y-4">
        {ratio != null ? (
          <Meter value={ratio * 100} color={meterColor(ratio)} aria-label={t("used")}>
            <Label>{t("used")}</Label>
            <Meter.Output />
            <Meter.Track>
              <Meter.Fill />
            </Meter.Track>
          </Meter>
        ) : null}
        <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <div className="min-w-0">
            <dt className="text-xs text-muted">{t("spent")}</dt>
            <dd className="text-lg font-semibold tabular-nums">
              {format.number(budget.spend, "currency")}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted">{t("limit")}</dt>
            <dd className="text-lg font-semibold tabular-nums">
              {t("limitValue", {
                capped: capped ? "yes" : "no",
                cap: budget.maxBudget,
                hasBoost: budget.boost > 0 ? "yes" : "no",
                boost: budget.boost,
              })}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted">{t("available")}</dt>
            <dd
              className={`text-lg font-semibold tabular-nums ${binding && binding.amount <= 0 ? "text-danger" : ""}`}
            >
              {binding ? format.number(binding.amount, "currency") : t("unlimited")}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted">{t("projected")}</dt>
            <dd className="text-lg font-semibold tabular-nums">
              {format.number(budget.projectedMonth, "currency")}
            </dd>
          </div>
        </dl>
        {budget.daysToExhaust != null ? (
          <p className="text-sm text-muted">
            {t("exhausts", { days: Math.max(0, Math.ceil(budget.daysToExhaust)) })}
          </p>
        ) : null}
        {limitedBy ? (
          <Alert status={limitedBy.amount <= 0 ? "danger" : "warning"}>
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>
                {t("limitedBy", {
                  kind: limitedBy.link.kind,
                  alias: limitedBy.link.alias,
                  amount: limitedBy.amount,
                })}
              </Alert.Description>
            </Alert.Content>
          </Alert>
        ) : !capped ? (
          <p className="text-sm text-muted">{t("inherits")}</p>
        ) : null}
      </Card.Content>
    </Card>
  );
}
