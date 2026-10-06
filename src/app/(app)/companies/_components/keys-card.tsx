"use client";

import { Button, Card, Chip, Table } from "@heroui/react";
import { Plus, Wallet } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link, useRouter } from "@/i18n/routing";
import type { BudgetTarget, KeyNode, NodeKind, StructurePayload } from "@/types/structure";
import { nodeAlias } from "./tree-model";

export default function KeysCard({
  data,
  keys,
  kind,
  createFor,
  onBudget,
}: {
  data: StructurePayload;
  keys: KeyNode[];
  kind: NodeKind;
  createFor: { kind: "project" | "member"; id: string } | null;
  onBudget: (target: BudgetTarget) => void;
}) {
  const t = useTranslations("Companies.keys");
  const tCommon = useTranslations("Common");
  const router = useRouter();

  function owner(key: KeyNode) {
    if (key.memberId) return { kind: "member", name: nodeAlias(data, "member", key.memberId) };
    if (key.projectId) return { kind: "project", name: nodeAlias(data, "project", key.projectId) };
    return { kind: "internal", name: nodeAlias(data, "user", key.userId) };
  }

  return (
    <Card>
      <Card.Header className="flex-row flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Card.Title>{t("title", { count: keys.length })}</Card.Title>
          <Card.Description>{t("hint", { kind })}</Card.Description>
        </div>
        {createFor && data.canCreateKeys ? (
          <Button size="sm" onPress={() => router.push(`/keys?new=${createFor.kind}:${createFor.id}`)}>
            <Plus size={14} aria-hidden />
            {t("create")}
          </Button>
        ) : null}
      </Card.Header>
      <Card.Content>
        {keys.length === 0 ? (
          <p className="text-sm text-muted">
            {t.rich("empty", {
              kind,
              link: (chunks) => (
                <Link href="/keys" className="text-accent">
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
                  {keys.map((key) => {
                    const bound = owner(key);
                    return (
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
                        <Table.Cell>
                          <div className="min-w-0">
                            <p className="text-sm">{bound.name || tCommon("none")}</p>
                            <p className="text-xs text-muted">{t("ownerKind", { kind: bound.kind })}</p>
                          </div>
                        </Table.Cell>
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
                    );
                  })}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        )}
      </Card.Content>
    </Card>
  );
}
