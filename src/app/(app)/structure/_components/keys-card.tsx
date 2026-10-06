"use client";

import { Button, Card, Chip, Table } from "@heroui/react";
import { Wallet } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/routing";
import type { BudgetTarget, KeyNode, StructurePayload } from "@/types/structure";

export default function KeysCard({
  data,
  keys,
  kind,
  onBudget,
}: {
  data: StructurePayload;
  keys: KeyNode[];
  kind: "team" | "project";
  onBudget: (target: BudgetTarget) => void;
}) {
  const t = useTranslations("Structure.keys");
  const tCommon = useTranslations("Common");
  const owner = (id: string) => data.users.find((user) => user.id === id)?.username ?? "";

  return (
    <Card>
      <Card.Header>
        <Card.Title>{t("title", { count: keys.length })}</Card.Title>
        <Card.Description>{t("hint", { kind })}</Card.Description>
      </Card.Header>
      <Card.Content>
        {keys.length === 0 ? (
          <p className="text-sm text-muted">
            {t.rich("empty", {
              link: (chunks) => (
                <Link href="/" className="text-accent">
                  {chunks}
                </Link>
              ),
            })}
          </p>
        ) : (
          <Table aria-label={t("title", { count: keys.length })}>
            <Table.ScrollContainer>
              <Table.Content className="min-w-xl">
                <Table.Header>
                  <Table.Column isRowHeader>{t("columns.key")}</Table.Column>
                  <Table.Column>{t("columns.owner")}</Table.Column>
                  <Table.Column>{t("columns.budget")}</Table.Column>
                  {data.canBudget ? <Table.Column>{tCommon("actions")}</Table.Column> : null}
                </Table.Header>
                <Table.Body>
                  {keys.map((key) => (
                    <Table.Row key={key.id} id={key.id}>
                      <Table.Cell>
                        <div className="min-w-0">
                          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                            {key.alias}
                            {key.blocked ? (
                              <Chip size="sm" variant="soft" color="danger">
                                {tCommon("blockedState", { blocked: "true" })}
                              </Chip>
                            ) : null}
                          </p>
                          <p className="font-mono text-xs text-muted">{key.prefix}…</p>
                        </div>
                      </Table.Cell>
                      <Table.Cell>{owner(key.userId) || tCommon("none")}</Table.Cell>
                      <Table.Cell>
                        {tCommon("spendBudget", {
                          hasCap: key.budget.maxBudget > 0 ? "yes" : "no",
                          spend: key.budget.spend,
                          budget: key.budget.maxBudget + key.budget.boost,
                        })}
                      </Table.Cell>
                      {data.canBudget ? (
                        <Table.Cell>
                          <Button
                            isIconOnly
                            size="sm"
                            variant="ghost"
                            aria-label={t("budget", { alias: key.alias })}
                            onPress={() => onBudget({ kind: "key", id: key.id, alias: key.alias })}
                          >
                            <Wallet size={14} aria-hidden />
                          </Button>
                        </Table.Cell>
                      ) : null}
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        )}
      </Card.Content>
    </Card>
  );
}
