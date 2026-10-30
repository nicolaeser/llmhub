"use client";

import { useEffect, useState } from "react";
import { Button, Card, Chip, SearchField, Table } from "@heroui/react";
import { UserPlus, UserRound } from "lucide-react";
import { useTranslations } from "next-intl";
import EmptyState from "@/components/console/empty-state";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import type { MemberNode, NodeRef, StructurePayload } from "@/types/structure";
import NodeMenu from "./node-menu";
import SpendMeter from "./spend-meter";
import { matchesMember, nodeActions, type NodeAction, type NodeFlags } from "./tree-model";

const SEARCH_FROM = 6;

export default function PeopleTab({
  data,
  flags,
  focus,
  onAdd,
  onAction,
}: {
  data: StructurePayload;
  flags: NodeFlags;
  focus: NodeRef | null;
  onAdd: () => void;
  onAction: (ref: { kind: "member"; id: string; alias: string }, action: NodeAction) => void;
}) {
  const t = useTranslations("Companies.people");
  const tCommon = useTranslations("Common");
  const [query, setQuery] = useState("");
  const members = data.members.filter((member) => matchesMember(member, query));
  const focused = focus?.kind === "member" ? focus.id : null;
  const teamAlias = (teamId: string) => data.teams.find((row) => row.id === teamId)?.alias ?? "";
  const keyCount = (memberId: string) => data.keys.filter((key) => key.memberId === memberId).length;

  useEffect(() => {
    if (!focused) return;
    const shown = [...document.querySelectorAll(`[data-focus="${focused}"]`)].find(
      (element) => element instanceof HTMLElement && element.offsetParent !== null,
    );
    shown?.scrollIntoView({ block: "center" });
  }, [focused]);

  const addButton = flags.canManage ? (
    <Button onPress={onAdd}>
      <UserPlus size={16} aria-hidden />
      {t("add")}
    </Button>
  ) : null;

  if (data.members.length === 0) {
    return (
      <EmptyState
        icon={UserRound}
        title={t("emptyTitle")}
        description={t("empty", { manage: flags.canManage ? "yes" : "no" })}
        action={addButton ?? undefined}
      />
    );
  }

  function blockedChip(member: MemberNode) {
    if (!member.blocked) return null;
    return (
      <Chip size="sm" variant="soft" color="danger">
        {tCommon("blockedState", { blocked: "true" })}
      </Chip>
    );
  }

  function menu(member: MemberNode) {
    return (
      <NodeMenu
        kind="member"
        name={member.alias}
        actions={nodeActions("member", flags, member.budget.maxBudget > 0)}
        onAction={(action) => onAction({ kind: "member", id: member.id, alias: member.alias }, action)}
      />
    );
  }

  const department = (member: MemberNode) => teamAlias(member.teamId) || t("noTeam");
  const meter = (member: MemberNode) => <SpendMeter budget={member.budget} label={t("usage", { name: member.alias })} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {data.members.length >= SEARCH_FROM ? (
          <SearchField value={query} onChange={setQuery} aria-label={t("search")} className="w-full sm:max-w-xs">
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input placeholder={t("search")} />
              <SearchField.ClearButton aria-label={t("clear")} />
            </SearchField.Group>
          </SearchField>
        ) : (
          <p className="max-w-2xl text-sm text-muted">{t("hint")}</p>
        )}
        {addButton}
      </div>

      {members.length === 0 ? (
        <Card>
          <Card.Content>
            <p className="text-sm text-muted">{t("noMatches")}</p>
          </Card.Content>
        </Card>
      ) : (
        <>
          <RowCards label={t("title")}>
            {members.map((member) => (
              <RowCard
                key={member.id}
                title={<span data-focus={member.id}>{member.alias}</span>}
                description={member.email || undefined}
                aside={menu(member)}
                chips={
                  focused === member.id || member.blocked ? (
                    <>
                      {focused === member.id ? (
                        <Chip size="sm" variant="soft" color="accent">
                          {t("selected")}
                        </Chip>
                      ) : null}
                      {blockedChip(member)}
                    </>
                  ) : undefined
                }
                details={[
                  { label: t("columns.team"), value: department(member) },
                  ...(data.canSeeKeys ? [{ label: t("columns.keys"), value: keyCount(member.id) }] : []),
                  { label: t("columns.budget"), value: meter(member), wide: true },
                ]}
              />
            ))}
          </RowCards>
          <Table aria-label={t("title")} className={TABLE_FROM_LG}>
            <Table.ScrollContainer>
              <Table.Content aria-label={t("title")} className="min-w-3xl">
                <Table.Header>
                  <Table.Column isRowHeader>{t("columns.person")}</Table.Column>
                  <Table.Column>{t("columns.team")}</Table.Column>
                  {data.canSeeKeys ? <Table.Column>{t("columns.keys")}</Table.Column> : null}
                  <Table.Column>{t("columns.budget")}</Table.Column>
                  <Table.Column>
                    <span className="sr-only">{tCommon("actions")}</span>
                  </Table.Column>
                </Table.Header>
                <Table.Body>
                  {members.map((member) => (
                    <Table.Row
                      key={member.id}
                      id={member.id}
                      className={focused === member.id ? "bg-accent/8" : undefined}
                    >
                      <Table.Cell>
                        <div data-focus={member.id} className="min-w-0">
                          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                            {member.alias}
                            {blockedChip(member)}
                          </p>
                          {member.email ? <p className="text-xs break-all text-muted">{member.email}</p> : null}
                        </div>
                      </Table.Cell>
                      <Table.Cell>{department(member)}</Table.Cell>
                      {data.canSeeKeys ? (
                        <Table.Cell className="tabular-nums">{keyCount(member.id)}</Table.Cell>
                      ) : null}
                      <Table.Cell>
                        <div className="w-48">{meter(member)}</div>
                      </Table.Cell>
                      <Table.Cell>
                        <div className="flex justify-end">{menu(member)}</div>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        </>
      )}
    </div>
  );
}
