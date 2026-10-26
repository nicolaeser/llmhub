"use client";

import { useCallback, useState } from "react";
import { Button, Skeleton, Table, type SortDescriptor } from "@heroui/react";
import { Activity, Bot, ChevronRight, Coins, Layers } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import CopyButton from "@/components/console/copy-button";
import EmptyState from "@/components/console/empty-state";
import { LoadError, SectionLoading } from "@/components/console/page-status";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import StatCard from "@/components/console/stat-card";
import { useActionData } from "@/lib/hooks/use-action-data";
import { useClock } from "@/lib/hooks/use-clock";
import { consoleTimeZone } from "@/lib/hooks/use-console-time-zone";
import { isActionFail } from "@/lib/http/action-result";
import { zonedLogFilters } from "@/lib/gateway/request-logs/request-log-query";
import { cacheHitRate } from "@/lib/usage/usage-stats";
import type { LogFilterValues, LogSessionRef, LogSessionRow, LogSessionSort, LogSessionSortKey } from "@/types/logs";
import { loadLogSessionsAction } from "../_action";
import {
  ActiveChip,
  ActivityCell,
  CostCell,
  ModelChips,
  RequestsCell,
  SessionIdentity,
  shortId,
  SwitchesCell,
  useCallerLabels,
  useCompactTokens,
} from "./session-cells";
import { useSessionFormat } from "./session-format";
import { useLiveReload } from "./use-live-reload";

const PAGE_SIZE = 25;
const NOW_INTERVAL_MS = 30_000;
const RECENT_FIRST: LogSessionSort = { by: "recent", direction: "desc" };
const SORT_KEYS: readonly LogSessionSortKey[] = ["recent", "cost", "requests"];

function rowKey(row: LogSessionRef): string {
  return `${row.sessionId}\u0000${row.keyId}\u0000${row.userId}`;
}

function descriptorOf(sort: LogSessionSort): SortDescriptor {
  return {
    column: sort.by,
    direction: sort.direction === "asc" ? "ascending" : "descending",
  };
}

function sortOf(descriptor: SortDescriptor, current: LogSessionSort): LogSessionSort {
  const by = SORT_KEYS.find((key) => key === descriptor.column) ?? "recent";
  if (by !== current.by) return { by, direction: "desc" };
  return {
    by,
    direction: descriptor.direction === "ascending" ? "asc" : "desc",
  };
}

export default function SessionList({
  filters,
  onOpen,
}: {
  filters: LogFilterValues;
  onOpen: (ref: LogSessionRef) => void;
}) {
  const t = useTranslations("Logs");
  const tSessions = useTranslations("Logs.sessions");
  const format = useFormatter();
  const now = useClock(NOW_INTERVAL_MS);
  const tokens = useCompactTokens();
  const caller = useCallerLabels();
  const session = useSessionFormat();
  const [sort, setSort] = useState<LogSessionSort>(RECENT_FIRST);
  const fetchPage = useCallback(
    (requested: number, order: LogSessionSort) =>
      loadLogSessionsAction({
        page: requested,
        pageSize: PAGE_SIZE,
        sort: order,
        filters: zonedLogFilters(filters, consoleTimeZone()),
      }),
    [filters],
  );
  const state = useActionData(() => fetchPage(1, RECENT_FIRST));
  const { data, pending, setData } = state;
  const page = data?.page ?? 1;

  const refresh = useCallback(() => {
    fetchPage(1, sort).then((res) => {
      if (!isActionFail(res)) setData((current) => (current.page === 1 ? res : current));
    });
  }, [fetchPage, sort, setData]);
  useLiveReload(page === 1 && !pending, refresh);

  function load(next: number, order = sort) {
    setSort(order);
    state.reloadWith(() => fetchPage(next, order));
  }

  function open(row: LogSessionRef) {
    onOpen({ sessionId: row.sessionId, keyId: row.keyId, userId: row.userId });
  }

  function openButton(row: LogSessionRow) {
    return (
      <Button
        isIconOnly
        size="sm"
        variant="ghost"
        aria-label={tSessions("open", { session: row.sessionId })}
        onPress={() => open(row)}
      >
        <ChevronRight size={14} aria-hidden />
      </Button>
    );
  }

  if (!data) {
    return state.error ? <LoadError state={state} /> : <SectionLoading shape="table" rows={8} />;
  }

  const { totals } = data;
  const maxCost = Math.max(0, ...data.sessions.map((row) => row.cost));
  const byKey = new Map(data.sessions.map((row) => [rowKey(row), row]));

  return (
    <div className="space-y-4">
      <LoadError state={state} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={tSessions("totals.sessions")}
          value={pending ? null : format.number(data.total, "integer")}
          icon={Bot}
          hint={tSessions("totals.active", { count: totals.active })}
          tone={totals.active ? "success" : "accent"}
        />
        <StatCard
          label={tSessions("totals.cost")}
          value={pending ? null : format.number(totals.cost, "money")}
          icon={Coins}
          hint={tSessions("totals.perSession", {
            value: format.number(totals.cost / Math.max(1, data.total), "money"),
          })}
        />
        <StatCard
          label={tSessions("totals.requests")}
          value={pending ? null : format.number(totals.requests, "integer")}
          icon={Activity}
          tone={totals.errors ? "warning" : "accent"}
          hint={tSessions("totals.errorRate", {
            errors: totals.errors,
            rate: totals.errors / Math.max(1, totals.requests),
          })}
        />
        <StatCard
          label={tSessions("totals.tokens")}
          value={pending ? null : tokens(totals.promptTokens, totals.completionTokens)}
          icon={Layers}
          tone="neutral"
          hint={tSessions("totals.cacheShare", {
            rate: Math.min(1, cacheHitRate(totals.cacheReadTokens, totals.promptTokens)),
          })}
        />
      </div>
      {pending ? (
        <SectionLoading shape="table" rows={8} />
      ) : !data.sessions.length ? (
        <EmptyState icon={Bot} title={tSessions("empty")} description={tSessions("emptyHint")} />
      ) : (
        <>
          <RowCards label={t("tabs.sessions")}>
            {data.sessions.map((row) => (
              <RowCard
                key={rowKey(row)}
                title={session.title(row.agent)}
                description={
                  <>
                    <code title={row.sessionId} className="font-mono text-xs">
                      {shortId(row.sessionId)}
                    </code>
                    <span className="block">
                      {tSessions("callerLine", { key: caller.key(row), person: caller.person(row) })}
                    </span>
                  </>
                }
                aside={
                  <>
                    <CopyButton text={row.sessionId} label={tSessions("copy")} />
                    {openButton(row)}
                  </>
                }
                chips={row.active ? <ActiveChip active /> : undefined}
                details={[
                  {
                    label: tSessions("columns.lastActivity"),
                    value: <ActivityCell row={row} now={now} />,
                    wide: true,
                  },
                  {
                    label: tSessions("columns.requests"),
                    value: <RequestsCell row={row} />,
                  },
                  {
                    label: t("columns.cost"),
                    value: <CostCell row={row} max={maxCost} />,
                  },
                  {
                    label: tSessions("columns.switches"),
                    value: <SwitchesCell row={row} />,
                  },
                  {
                    label: tSessions("columns.models"),
                    value: <ModelChips models={row.models} />,
                    wide: true,
                  },
                ]}
              />
            ))}
          </RowCards>
          <Table aria-label={t("tabs.sessions")} className={TABLE_FROM_LG}>
            <Table.ScrollContainer>
              <Table.Content
                aria-label={t("tabs.sessions")}
                className="min-w-5xl"
                sortDescriptor={descriptorOf(data.sort)}
                onSortChange={(descriptor) => load(1, sortOf(descriptor, data.sort))}
                onRowAction={(key) => {
                  const row = byKey.get(String(key));
                  if (row) open(row);
                }}
              >
                <Table.Header>
                  <Table.Column isRowHeader>{tSessions("columns.session")}</Table.Column>
                  <Table.Column allowsSorting id="recent">
                    {({ sortDirection }) => (
                      <Table.SortableColumnHeader sortDirection={sortDirection}>
                        {tSessions("columns.lastActivity")}
                      </Table.SortableColumnHeader>
                    )}
                  </Table.Column>
                  <Table.Column allowsSorting id="requests">
                    {({ sortDirection }) => (
                      <Table.SortableColumnHeader sortDirection={sortDirection}>
                        {tSessions("columns.requests")}
                      </Table.SortableColumnHeader>
                    )}
                  </Table.Column>
                  <Table.Column allowsSorting id="cost">
                    {({ sortDirection }) => (
                      <Table.SortableColumnHeader sortDirection={sortDirection}>
                        {t("columns.cost")}
                      </Table.SortableColumnHeader>
                    )}
                  </Table.Column>
                  <Table.Column>{tSessions("columns.models")}</Table.Column>
                  <Table.Column>{tSessions("columns.switches")}</Table.Column>
                </Table.Header>
                <Table.Body>
                  {data.sessions.map((row) => (
                    <Table.Row key={rowKey(row)} id={rowKey(row)}>
                      <Table.Cell>
                        <div className="w-64">
                          <SessionIdentity row={row} action={openButton(row)} />
                        </div>
                      </Table.Cell>
                      <Table.Cell>
                        <ActivityCell row={row} now={now} />
                      </Table.Cell>
                      <Table.Cell>
                        <div className="w-40">
                          <RequestsCell row={row} />
                        </div>
                      </Table.Cell>
                      <Table.Cell>
                        <div className="w-32">
                          <CostCell row={row} max={maxCost} />
                        </div>
                      </Table.Cell>
                      <Table.Cell>
                        <div className="min-w-32 max-w-48">
                          <ModelChips models={row.models} />
                        </div>
                      </Table.Cell>
                      <Table.Cell>
                        <SwitchesCell row={row} />
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        </>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {pending ? (
          <Skeleton className="h-3.5 w-40 rounded-lg" />
        ) : (
          <p className="text-sm text-muted">
            {tSessions("pageStatus", {
              page,
              total: data.total,
              capped: String(data.capped),
            })}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            isDisabled={page <= 1}
            isPending={pending}
            onPress={() => load(page - 1)}
          >
            {t("prev")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            isDisabled={page * data.pageSize >= data.total}
            isPending={pending}
            onPress={() => load(page + 1)}
          >
            {t("next")}
          </Button>
        </div>
      </div>
    </div>
  );
}
