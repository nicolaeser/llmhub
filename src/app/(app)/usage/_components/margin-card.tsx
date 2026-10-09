"use client";

import { useState } from "react";
import { Card, Table, ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { useFormatter, useTranslations } from "next-intl";
import { marginShare } from "@/lib/gateway/markup-policy";
import { chargebackParts } from "@/lib/gateway/usage-stats";
import type { SliceRow } from "@/types/gateway";
import type { MarginGroup, MarginRow } from "@/types/pricing";

const GROUPS = ["orgId", "teamId", "projectId", "model"] as const satisfies readonly MarginGroup[];

const GROUP_LABEL = { orgId: "org", teamId: "team", projectId: "project", model: "model" } as const;

function marginRows(rows: SliceRow[], group: MarginGroup): MarginRow[] {
  const totals = new Map<string, MarginRow>();
  for (const row of rows) {
    const id = chargebackParts(row.name)[group];
    const current = totals.get(id) ?? { id, purchase: 0, sale: 0 };
    current.purchase += row.purchase ?? 0;
    current.sale += row.spend;
    totals.set(id, current);
  }
  return [...totals.values()].sort((a, b) => b.sale - a.sale);
}

function marginClass(margin: number): string {
  return margin < 0 ? "font-medium text-danger tabular-nums" : "font-medium tabular-nums";
}

export default function MarginCard({
  chargeback,
  names,
  purchase,
  sale,
}: {
  chargeback: SliceRow[];
  names: Record<string, string>;
  purchase: number;
  sale: number;
}) {
  const t = useTranslations("Usage");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const [group, setGroup] = useState<MarginGroup>("orgId");
  const rows = marginRows(chargeback, group);
  const share = marginShare(purchase, sale);
  const label = (id: string) =>
    !id ? tCommon("none") : group === "model" ? id : (names[id] ?? t("deleted", { group: GROUP_LABEL[group] }));
  const percent = (value: number | null) => (value === null ? tCommon("none") : format.number(value, "percent"));

  return (
    <Card className="mt-5 gap-4">
      <Card.Header className="flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <Card.Title>{t("margin.title")}</Card.Title>
          <Card.Description>{t("margin.description")}</Card.Description>
        </div>
        <ToggleButtonGroup
          size="sm"
          selectionMode="single"
          disallowEmptySelection
          aria-label={t("margin.groupBy")}
          selectedKeys={[group]}
          onSelectionChange={(keys) => {
            const next = GROUPS.find((item) => keys.has(item));
            if (next) setGroup(next);
          }}
        >
          {GROUPS.map((item, index) => (
            <ToggleButton key={item} id={item}>
              {index > 0 ? <ToggleButtonGroup.Separator /> : null}
              {t(`group.${GROUP_LABEL[item]}`)}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Card.Header>
      <Card.Content className="space-y-4">
        <dl className="grid gap-3 sm:grid-cols-3">
          {(
            [
              ["purchase", format.number(purchase, "money"), "text-xl font-semibold tracking-tight tabular-nums"],
              ["sale", format.number(sale, "money"), "text-xl font-semibold tracking-tight tabular-nums"],
              [
                "margin",
                share === null
                  ? format.number(sale - purchase, "money")
                  : t("margin.value", { amount: sale - purchase, share }),
                sale - purchase < 0
                  ? "text-xl font-semibold tracking-tight text-danger tabular-nums"
                  : "text-xl font-semibold tracking-tight text-success tabular-nums",
              ],
            ] as const
          ).map(([key, value, className]) => (
            <div key={key} className="rounded-lg bg-default px-4 py-3">
              <dt className="text-sm text-muted">{t(`margin.metrics.${key}`)}</dt>
              <dd className={className}>{value}</dd>
            </div>
          ))}
        </dl>
        {rows.length ? (
          <Table aria-label={t("margin.title")}>
            <Table.ScrollContainer>
              <Table.Content aria-label={t("margin.title")} className="min-w-[40rem]">
                <Table.Header>
                  <Table.Column isRowHeader>{t(`group.${GROUP_LABEL[group]}`)}</Table.Column>
                  <Table.Column>{t("margin.metrics.purchase")}</Table.Column>
                  <Table.Column>{t("margin.metrics.sale")}</Table.Column>
                  <Table.Column>{t("margin.metrics.margin")}</Table.Column>
                  <Table.Column>{t("margin.share")}</Table.Column>
                </Table.Header>
                <Table.Body>
                  {rows.map((row) => (
                    <Table.Row key={row.id || "none"} id={row.id || "none"}>
                      <Table.Cell>{label(row.id)}</Table.Cell>
                      <Table.Cell className="tabular-nums">{format.number(row.purchase, "money")}</Table.Cell>
                      <Table.Cell className="tabular-nums">{format.number(row.sale, "money")}</Table.Cell>
                      <Table.Cell>
                        <span className={marginClass(row.sale - row.purchase)}>
                          {format.number(row.sale - row.purchase, "money")}
                        </span>
                      </Table.Cell>
                      <Table.Cell className="tabular-nums">{percent(marginShare(row.purchase, row.sale))}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        ) : (
          <p className="text-sm text-muted">{t("margin.empty")}</p>
        )}
      </Card.Content>
    </Card>
  );
}
