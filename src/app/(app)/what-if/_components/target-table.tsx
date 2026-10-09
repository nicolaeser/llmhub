"use client";

import { useState } from "react";
import { Button, Card, Chip, Label, Switch, Table } from "@heroui/react";
import { useFormatter, useTranslations } from "next-intl";
import { compareCost } from "@/lib/gateway/what-if";
import type { WhatIfTarget } from "@/types/what-if";

const PAGE_SIZE = 25;

export default function TargetTable({
  targets,
  billed,
  source,
  selected,
  onSelect,
}: {
  targets: WhatIfTarget[];
  billed: number;
  source: string;
  selected: string;
  onSelect: (alias: string) => void;
}) {
  const t = useTranslations("WhatIf");
  const format = useFormatter();
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [withCatalog, setWithCatalog] = useState(false);
  const listed = withCatalog ? targets : targets.filter((item) => item.state !== "missing");
  const shown = listed.slice(0, limit);
  const hidden = listed.length - shown.length;

  return (
    <Card className="gap-4">
      <Card.Header className="flex-row flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Card.Title>{t("table.title")}</Card.Title>
          <Card.Description>{t("table.description")}</Card.Description>
        </div>
        <Switch
          size="sm"
          isSelected={withCatalog}
          onChange={(next) => {
            setWithCatalog(next);
            setLimit(PAGE_SIZE);
          }}
        >
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            <Label>{t("table.withCatalog")}</Label>
          </Switch.Content>
        </Switch>
      </Card.Header>
      <Table>
        <Table.ScrollContainer>
          <Table.Content
            aria-label={t("table.title")}
            selectionMode="single"
            selectionBehavior="replace"
            disallowEmptySelection
            selectedKeys={[selected]}
            onSelectionChange={(keys) => {
              if (keys === "all") return;
              const [key] = keys;
              if (key != null) onSelect(String(key));
            }}
            className="min-w-[36rem]"
          >
            <Table.Header>
              <Table.Column isRowHeader>{t("table.model")}</Table.Column>
              <Table.Column>{t("table.cost")}</Table.Column>
              <Table.Column>{t("table.change")}</Table.Column>
            </Table.Header>
            <Table.Body>
              {shown.map((item) => {
                const comparison = compareCost(billed, item.cost);
                return (
                  <Table.Row key={item.alias} id={item.alias} textValue={item.alias}>
                    <Table.Cell>
                      <div className="flex min-w-0 flex-col gap-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{item.alias}</span>
                          {item.alias === source ? (
                            <Chip size="sm" variant="soft" color="accent">
                              {t("current")}
                            </Chip>
                          ) : null}
                          {item.state === "active" ? null : (
                            <Chip size="sm" variant="soft" color="warning">
                              {t("state", { state: item.state })}
                            </Chip>
                          )}
                          {item.scheduled ? (
                            <Chip size="sm" variant="soft">
                              {t("scheduled")}
                            </Chip>
                          ) : null}
                        </div>
                        {item.vendor || item.displayName ? (
                          <span className="text-xs text-muted">
                            {format.list([item.vendor, item.displayName].filter(Boolean), { type: "unit" })}
                          </span>
                        ) : null}
                      </div>
                    </Table.Cell>
                    <Table.Cell>{format.number(item.cost, "money")}</Table.Cell>
                    <Table.Cell>
                      <span
                        className={
                          comparison.direction === "saved"
                            ? "text-success"
                            : comparison.direction === "more"
                              ? "text-danger"
                              : "text-muted"
                        }
                      >
                        {t("change", { direction: comparison.direction, share: comparison.share })}
                      </span>
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
      {hidden > 0 ? (
        <Card.Footer>
          <Button variant="secondary" onPress={() => setLimit((n) => n + PAGE_SIZE)}>
            {t("more", { count: Math.min(PAGE_SIZE, hidden) })}
          </Button>
        </Card.Footer>
      ) : null}
    </Card>
  );
}
