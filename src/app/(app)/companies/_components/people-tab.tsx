"use client";

import { useEffect, useState } from "react";
import { Button, Card, Chip, SearchField, Table } from "@heroui/react";
import { UserPlus, UserRound } from "lucide-react";
import { useTranslations } from "next-intl";
import EmptyState from "@/components/console/empty-state";
import PauseChip from "@/components/console/pause-chip";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import { columnSort, descriptorOf, sortByColumn, type ColumnSort } from "@/components/console/table-sort";
import { useClock } from "@/lib/hooks/use-clock";
import { isPaused } from "@/lib/keys/pause";
import type { MemberNode, NodeRef, StructurePayload } from "@/types/structure";
import NodeMenu from "./node-menu";
import SpendMeter from "./spend-meter";
import { matchesMember, nodeActions, nodePause, type NodeAction, type NodeFlags } from "./tree-model";

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
  const now = useClock(60_000);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ColumnSort | null>(null);
  const members = data.members.filter((member) => matchesMember(member, query));
  const focused = focus?.kind === "member" ? focus.id : null;
  const teamAlias = (teamId: string) => data.teams.find((row) => row.id === teamId)?.alias ?? "";
  const keyCount = (memberId: string) => data.keys.filter((key) => key.memberId === memberId).length;
  const shown = sortByColumn(members, sort, (member, column) => {
    if (column === "person") return member.alias;
    if (column === "team") return teamAlias(member.teamId) || null;
    if (column === "keys") return keyCount(member.id);
    if (column === "budget") return member.budget.spend;
    return null;
  });

  useEffect(() => {
    if (!focused) return;
    const target = [...document.querySelectorAll(`[data-focus="${focused}"]`)].find(
      (element) => element instanceof HTMLElement && element.offsetParent !== null,
    );
    target?.scrollIntoView({ block: "center" });
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

  function stateChips(member: MemberNode) {
    const pause = nodePause(data, { kind: "member", id: member.id }, now);
    return (
      <>
        {member.blocked ? (
          <Chip size="sm" variant="soft" color="danger">
            {tCommon("blockedState", { blocked: "true" })}
          </Chip>
        ) : null}
        {pause ? <PauseChip pause={pause} own="member" /> : null}
      </>
    );
  }

  function flagged(member: MemberNode) {
    return member.blocked || nodePause(data, { kind: "member", id: member.id }, now) !== null;
  }

  function menu(member: MemberNode) {
    return (
      <NodeMenu
        kind="member"
        name={member.alias}
        actions={nodeActions("member", flags, {
          capped: member.budget.maxBudget > 0,
          paused: isPaused(member, now),
        })}
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
            {shown.map((member) => (
              <RowCard
                key={member.id}
                title={<span data-focus={member.id}>{member.alias}</span>}
                description={member.email || undefined}
                aside={menu(member)}
                chips={
                  focused === member.id || flagged(member) ? (
                    <>
                      {focused === member.id ? (
                        <Chip size="sm" variant="soft" color="accent">
                          {t("selected")}
                        </Chip>
                      ) : null}
                      {stateChips(member)}
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
              <Table.Content
                aria-label={t("title")}
                className="min-w-3xl"
                sortDescriptor={sort ? descriptorOf(sort) : undefined}
                onSortChange={(descriptor) => setSort(columnSort(descriptor, sort))}
              >
                <Table.Header>
                  <Table.Column isRowHeader allowsSorting id="person">
                    {({ sortDirection }) => (
                      <Table.SortableColumnHeader sortDirection={sortDirection}>
                        {t("columns.person")}
                      </Table.SortableColumnHeader>
                    )}
                  </Table.Column>
                  <Table.Column allowsSorting id="team">
                    {({ sortDirection }) => (
                      <Table.SortableColumnHeader sortDirection={sortDirection}>
                        {t("columns.team")}
                      </Table.SortableColumnHeader>
                    )}
                  </Table.Column>
                  {data.canSeeKeys ? (
                    <Table.Column allowsSorting id="keys">
                      {({ sortDirection }) => (
                        <Table.SortableColumnHeader sortDirection={sortDirection}>
                          {t("columns.keys")}
                        </Table.SortableColumnHeader>
                      )}
                    </Table.Column>
                  ) : null}
                  <Table.Column allowsSorting id="budget">
                    {({ sortDirection }) => (
                      <Table.SortableColumnHeader sortDirection={sortDirection}>
                        {t("columns.budget")}
                      </Table.SortableColumnHeader>
                    )}
                  </Table.Column>
                  <Table.Column>
                    <span className="sr-only">{tCommon("actions")}</span>
                  </Table.Column>
                </Table.Header>
                <Table.Body>
                  {shown.map((member) => (
                    <Table.Row
                      key={member.id}
                      id={member.id}
                      className={focused === member.id ? "bg-accent/8" : undefined}
                    >
                      <Table.Cell>
                        <div data-focus={member.id} className="min-w-0">
                          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                            {member.alias}
                            {stateChips(member)}
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
