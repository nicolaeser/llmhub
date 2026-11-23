"use client";

import { useState } from "react";
import { Button, buttonVariants, Card, SearchField, Spinner, Table } from "@heroui/react";
import { ChevronRight, KeyRound, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import EmptyState from "@/components/console/empty-state";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import { columnSort, descriptorOf, sortByColumn, type ColumnSort } from "@/components/console/table-sort";
import KeyStateChip from "@/components/keys/key-state-chip";
import { Link } from "@/i18n/routing";
import { useClock } from "@/lib/hooks/use-clock";
import { keyState } from "@/lib/keys/pause";
import type { KeyNode, StructurePayload } from "@/types/structure";
import SpendMeter from "./spend-meter";
import { matchesKey, nodeAlias, nodePause } from "./tree-model";

const SEARCH_FROM = 6;

export default function KeysTab({
  data,
  creating,
  onCreate,
}: {
  data: StructurePayload;
  creating: boolean;
  onCreate: (() => void) | null;
}) {
  const t = useTranslations("Companies.keys");
  const tCommon = useTranslations("Common");
  const now = useClock(60_000);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ColumnSort | null>(null);
  const keys = data.keys.filter((key) => matchesKey(key, query));

  const createButton = onCreate ? (
    <Button isPending={creating} onPress={onCreate}>
      {({ isPending }) => (
        <>
          {isPending ? <Spinner color="current" size="sm" /> : <Plus size={16} aria-hidden />}
          {t("create")}
        </>
      )}
    </Button>
  ) : null;

  if (data.keys.length === 0) {
    return (
      <EmptyState
        icon={KeyRound}
        title={t("emptyTitle")}
        description={t("empty", { create: onCreate ? "yes" : "no" })}
        action={createButton ?? undefined}
      />
    );
  }

  function ownerOf(key: KeyNode) {
    const kind = key.memberId ? "member" : key.projectId ? "project" : "internal";
    const name =
      kind === "member"
        ? nodeAlias(data, "member", key.memberId)
        : kind === "project"
          ? nodeAlias(data, "project", key.projectId)
          : nodeAlias(data, "user", key.userId);
    return { kind, name };
  }

  function owner(key: KeyNode) {
    const { kind, name } = ownerOf(key);
    return (
      <>
        <span className="block break-words">{name || tCommon("none")}</span>
        <span className="block text-xs text-muted">{t("ownerKind", { kind })}</span>
      </>
    );
  }

  const state = (key: KeyNode) => {
    const pause = nodePause(data, { kind: "key", id: key.id }, now);
    return <KeyStateChip state={keyState(key, now, pause)} pause={pause} />;
  };
  const meter = (key: KeyNode) => <SpendMeter budget={key.budget} label={t("usage", { alias: key.alias })} />;
  const shown = sortByColumn(keys, sort, (key, column) => {
    if (column === "key") return key.alias;
    if (column === "owner") return ownerOf(key).name || null;
    if (column === "status") return keyState(key, now, nodePause(data, { kind: "key", id: key.id }, now));
    if (column === "budget") return key.budget.spend;
    return null;
  });
  const open = (key: KeyNode) => (
    <Link
      href={`/keys/${key.id}`}
      aria-label={t("open", { alias: key.alias })}
      className={buttonVariants({ isIconOnly: true, size: "sm", variant: "ghost" })}
    >
      <ChevronRight size={14} aria-hidden />
    </Link>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {data.keys.length >= SEARCH_FROM ? (
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
        {createButton}
      </div>

      {keys.length === 0 ? (
        <Card>
          <Card.Content>
            <p className="text-sm text-muted">{t("noMatches")}</p>
          </Card.Content>
        </Card>
      ) : (
        <>
          <RowCards label={t("title")}>
            {shown.map((key) => (
              <RowCard
                key={key.id}
                title={
                  <Link href={`/keys/${key.id}`} className="text-foreground">
                    {key.alias}
                  </Link>
                }
                description={<span className="font-mono text-xs">{key.prefix}…</span>}
                aside={open(key)}
                chips={state(key)}
                details={[
                  { label: t("columns.owner"), value: owner(key) },
                  { label: t("columns.budget"), value: meter(key), wide: true },
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
                  <Table.Column isRowHeader allowsSorting id="key">
                    {({ sortDirection }) => (
                      <Table.SortableColumnHeader sortDirection={sortDirection}>
                        {t("columns.key")}
                      </Table.SortableColumnHeader>
                    )}
                  </Table.Column>
                  <Table.Column allowsSorting id="owner">
                    {({ sortDirection }) => (
                      <Table.SortableColumnHeader sortDirection={sortDirection}>
                        {t("columns.owner")}
                      </Table.SortableColumnHeader>
                    )}
                  </Table.Column>
                  <Table.Column allowsSorting id="status">
                    {({ sortDirection }) => (
                      <Table.SortableColumnHeader sortDirection={sortDirection}>
                        {tCommon("status")}
                      </Table.SortableColumnHeader>
                    )}
                  </Table.Column>
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
                  {shown.map((key) => (
                    <Table.Row key={key.id} id={key.id}>
                      <Table.Cell>
                        <div className="min-w-0">
                          <Link href={`/keys/${key.id}`} className="text-sm font-medium break-words text-foreground">
                            {key.alias}
                          </Link>
                          <p className="font-mono text-xs text-muted">{key.prefix}…</p>
                        </div>
                      </Table.Cell>
                      <Table.Cell>
                        <div className="min-w-0 text-sm">{owner(key)}</div>
                      </Table.Cell>
                      <Table.Cell>{state(key)}</Table.Cell>
                      <Table.Cell>
                        <div className="w-48">{meter(key)}</div>
                      </Table.Cell>
                      <Table.Cell>
                        <div className="flex justify-end">{open(key)}</div>
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
