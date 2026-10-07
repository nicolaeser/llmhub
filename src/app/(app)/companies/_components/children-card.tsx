"use client";

import { Button, Card, Meter } from "@heroui/react";
import { ChevronRight, Folder, Plus, Users } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { meterColor } from "@/lib/utils/budget";
import type { BudgetView, NodeRef } from "@/types/structure";
import { usedRatio } from "./tree-model";

export default function ChildrenCard({
  kind,
  rows,
  canManage,
  onOpen,
  onAdd,
}: {
  kind: "team" | "project";
  rows: { id: string; alias: string; budget: BudgetView; detail: string }[];
  canManage: boolean;
  onOpen: (ref: NodeRef) => void;
  onAdd: () => void;
}) {
  const t = useTranslations("Companies.children");
  const format = useFormatter();
  const Icon = kind === "team" ? Users : Folder;
  const allocated = rows.reduce((sum, row) => sum + row.budget.maxBudget, 0);

  return (
    <Card>
      <Card.Header className="flex-row flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Card.Title>{t("title", { kind, count: rows.length })}</Card.Title>
          <Card.Description>
            {allocated > 0 ? t("allocated", { kind, amount: allocated }) : t("hint", { kind })}
          </Card.Description>
        </div>
        {canManage ? (
          <Button size="sm" onPress={onAdd}>
            <Plus size={14} aria-hidden />
            {t("add", { kind })}
          </Button>
        ) : null}
      </Card.Header>
      <Card.Content>
        {rows.length === 0 ? (
          <p className="text-sm text-muted">{t("empty", { kind })}</p>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {rows.map((row) => {
              const ratio = usedRatio(row.budget);
              return (
                <li key={row.id}>
                  <Card variant="secondary" className="h-full gap-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <Icon size={14} aria-hidden className="shrink-0 text-muted" />
                        <p className="min-w-0 break-words text-sm font-medium">{row.alias}</p>
                      </div>
                      <Button
                        isIconOnly
                        size="sm"
                        variant="ghost"
                        aria-label={t("open", { alias: row.alias })}
                        onPress={() => onOpen({ kind, id: row.id })}
                      >
                        <ChevronRight size={14} aria-hidden />
                      </Button>
                    </div>
                    <p className="text-xs text-muted">{row.detail}</p>
                    {ratio != null ? (
                      <div className="space-y-1">
                        <div className="flex flex-wrap justify-between gap-2 text-xs text-muted">
                          <span>
                            {t("spendOf", {
                              spend: row.budget.spend,
                              cap: row.budget.maxBudget + row.budget.boost,
                            })}
                          </span>
                          <span className="tabular-nums">{format.number(ratio, "percent")}</span>
                        </div>
                        <Meter
                          size="sm"
                          value={ratio * 100}
                          color={meterColor(ratio)}
                          aria-label={t("usage", { alias: row.alias })}
                        >
                          <Meter.Track>
                            <Meter.Fill />
                          </Meter.Track>
                        </Meter>
                      </div>
                    ) : (
                      <p className="text-xs text-muted">
                        {t("noCap", { spend: row.budget.spend })}
                      </p>
                    )}
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </Card.Content>
    </Card>
  );
}
