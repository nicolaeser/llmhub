"use client";

import { Button, Card, Chip, Table } from "@heroui/react";
import { ChevronRight, Plus, Wallet } from "lucide-react";
import { useTranslations } from "next-intl";
import type { BudgetTarget, MemberNode, NodeRef, StructurePayload } from "@/types/structure";

export default function MembersCard({
  data,
  kind,
  members,
  onOpen,
  onAdd,
  onBudget,
}: {
  data: StructurePayload;
  kind: "org" | "team";
  members: MemberNode[];
  onOpen: (ref: NodeRef) => void;
  onAdd: () => void;
  onBudget: (target: BudgetTarget) => void;
}) {
  const t = useTranslations("Companies.members");
  const tCommon = useTranslations("Common");
  const teamAlias = (teamId: string) => data.teams.find((row) => row.id === teamId)?.alias ?? "";
  const keyCount = (memberId: string) => data.keys.filter((key) => key.memberId === memberId).length;

  return (
    <Card>
      <Card.Header className="flex-row flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Card.Title>{t("title", { count: members.length })}</Card.Title>
          <Card.Description>{t("hint", { kind })}</Card.Description>
        </div>
        {data.canManage ? (
          <Button size="sm" onPress={onAdd}>
            <Plus size={14} aria-hidden />
            {t("add")}
          </Button>
        ) : null}
      </Card.Header>
      <Card.Content>
        {members.length === 0 ? (
          <p className="text-sm text-muted">{t("empty", { kind })}</p>
        ) : (
          <Table aria-label={t("title", { count: members.length })}>
            <Table.ScrollContainer>
              <Table.Content className="min-w-xl">
                <Table.Header>
                  <Table.Column isRowHeader>{t("columns.person")}</Table.Column>
                  {kind === "org" ? <Table.Column>{t("columns.team")}</Table.Column> : null}
                  <Table.Column>{t("columns.keys")}</Table.Column>
                  <Table.Column>{t("columns.budget")}</Table.Column>
                  <Table.Column>{tCommon("actions")}</Table.Column>
                </Table.Header>
                <Table.Body>
                  {members.map((member) => (
                    <Table.Row key={member.id} id={member.id}>
                      <Table.Cell>
                        <div className="min-w-0">
                          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                            {member.alias}
                            {member.blocked ? (
                              <Chip size="sm" variant="soft" color="danger">
                                {tCommon("blockedState", { blocked: "true" })}
                              </Chip>
                            ) : null}
                          </p>
                          {member.email ? (
                            <p className="text-xs break-all text-muted">{member.email}</p>
                          ) : null}
                        </div>
                      </Table.Cell>
                      {kind === "org" ? (
                        <Table.Cell>{teamAlias(member.teamId) || t("noTeam")}</Table.Cell>
                      ) : null}
                      <Table.Cell className="tabular-nums">{keyCount(member.id)}</Table.Cell>
                      <Table.Cell>
                        {tCommon("spendBudget", {
                          hasCap: member.budget.maxBudget > 0 ? "yes" : "no",
                          spend: member.budget.spend,
                          budget: member.budget.maxBudget + member.budget.boost,
                        })}
                      </Table.Cell>
                      <Table.Cell>
                        <div className="flex gap-1">
                          {data.canBudget ? (
                            <Button
                              isIconOnly
                              size="sm"
                              variant="ghost"
                              aria-label={t("budget", { name: member.alias })}
                              onPress={() =>
                                onBudget({ kind: "member", id: member.id, alias: member.alias })
                              }
                            >
                              <Wallet size={14} aria-hidden />
                            </Button>
                          ) : null}
                          <Button
                            isIconOnly
                            size="sm"
                            variant="ghost"
                            aria-label={t("open", { name: member.alias })}
                            onPress={() => onOpen({ kind: "member", id: member.id })}
                          >
                            <ChevronRight size={14} aria-hidden />
                          </Button>
                        </div>
                      </Table.Cell>
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
