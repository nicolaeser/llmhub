"use client";

import { useState } from "react";
import { Button, Table } from "@heroui/react";
import { Activity, Coins, FileText, ScrollText } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { Link } from "@/i18n/routing";
import EmptyState from "@/components/console/empty-state";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import { columnSort, descriptorOf, sortByColumn, type ColumnSort } from "@/components/console/table-sort";
import type { loadLogsAction } from "../_action";
import type { LogKind, RequestLogRow } from "@/types/logs";
import GuardrailChip from "./guardrail-chip";
import LabelChips from "./label-chips";
import PiiChip from "./pii-chip";
import StatusChip from "./status-chip";

function guarded(row: RequestLogRow): boolean {
  return row.outcome === "guardrail_blocked" || row.guardInput.length > 0 || row.guardOutput.length > 0;
}

function epochMs(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export type LogsPayload = Exclude<Awaited<ReturnType<typeof loadLogsAction>>, { ok: false }>;

export default function LogTable({
  kind,
  logs,
  onOpen,
}: {
  kind: Exclude<LogKind, "sessions">;
  logs: LogsPayload;
  onOpen: (row: RequestLogRow) => void;
}) {
  const t = useTranslations("Logs");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const [requestSort, setRequestSort] = useState<ColumnSort | null>(null);
  const [spendSort, setSpendSort] = useState<ColumnSort | null>(null);
  const [auditSort, setAuditSort] = useState<ColumnSort | null>(null);

  function time(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : format.dateTime(date, "zoned");
  }

  function keyLabel(row: RequestLogRow) {
    if (row.system) return t("caller.system");
    return row.keyLabel || (row.keyId ? t("deleted", { kind: "key" }) : t("caller.noKey"));
  }

  function personLabel(row: RequestLogRow) {
    if (row.system) return t("caller.feature", { feature: row.system });
    return (
      row.memberLabel ||
      row.userLabel ||
      (row.memberId
        ? t("deleted", { kind: "member" })
        : row.userId
          ? t("deleted", { kind: "user" })
          : tCommon("none"))
    );
  }

  function keyCell(row: RequestLogRow) {
    const label = keyLabel(row);
    if (row.system || !row.keyId || !row.keyLabel) return <span className="text-sm break-words">{label}</span>;
    return (
      <Link href={`/keys/${encodeURIComponent(row.keyId)}`} className="text-sm break-words text-accent">
        {label}
      </Link>
    );
  }

  function caller(row: RequestLogRow) {
    return (
      <div className="min-w-32">
        {keyCell(row)}
        {row.system || row.memberId || row.userId ? (
          <p className="text-xs break-words text-muted">{personLabel(row)}</p>
        ) : null}
      </div>
    );
  }

  function usage(row: RequestLogRow) {
    return (
      <div className="min-w-0 tabular-nums">
        <p className="text-sm whitespace-nowrap">
          {t("tokenFlow", { prompt: row.promptTokens, completion: row.completionTokens })}
        </p>
        <p className="text-xs whitespace-nowrap text-muted">
          {t("costLatency", { cost: format.number(row.cost, "money"), latency: row.latencyMs })}
        </p>
      </div>
    );
  }

  function hasChecks(row: RequestLogRow) {
    return Boolean(row.piiMode) || row.piiInput.length > 0 || row.piiOutput.length > 0 || guarded(row);
  }

  function statusChip(row: RequestLogRow) {
    return <StatusChip status={row.status} outcome={row.outcome} />;
  }

  function policyChips(row: RequestLogRow) {
    return (
      <>
        {row.piiMode || !guarded(row) ? (
          <PiiChip outcome={row.outcome} piiMode={row.piiMode} piiInput={row.piiInput} piiOutput={row.piiOutput} />
        ) : null}
        <GuardrailChip outcome={row.outcome} guardInput={row.guardInput} guardOutput={row.guardOutput} />
      </>
    );
  }

  function detailButton(row: RequestLogRow) {
    return (
      <Button
        isIconOnly
        size="sm"
        variant="ghost"
        aria-label={t("openDetails", { model: row.model })}
        onPress={() => onOpen(row)}
      >
        <FileText size={14} aria-hidden />
      </Button>
    );
  }

  function changesCell(row: LogsPayload["audit"][number]) {
    return (
      <code
        title={[row.before, row.after].filter(Boolean).join("\n")}
        className="line-clamp-2 max-w-md font-mono text-xs break-all text-muted"
      >
        {row.after || row.before || "—"}
      </code>
    );
  }

  const requestRows = sortByColumn(logs.requests, requestSort, (row, column) => {
    if (column === "model") return row.model || null;
    if (column === "time") return epochMs(row.createdAt);
    if (column === "caller") return keyLabel(row);
    if (column === "status") return row.status;
    if (column === "usage") return row.promptTokens + row.completionTokens;
    if (column === "pii") {
      if (!hasChecks(row)) return null;
      return row.piiMode || row.outcome || null;
    }
    return null;
  });
  const spendRows = sortByColumn(logs.spend, spendSort, (row, column) => {
    if (column === "time") return epochMs(row.createdAt);
    if (column === "model") return row.model || null;
    if (column === "spend") return row.spend;
    if (column === "tokens") return row.promptTokens + row.completionTokens;
    return null;
  });
  const auditRows = sortByColumn(logs.audit, auditSort, (row, column) => {
    if (column === "time") return epochMs(row.createdAt);
    if (column === "actor") return row.actor || null;
    if (column === "action") return row.action || null;
    if (column === "object") return `${row.objectType} ${row.objectId}`.trim() || null;
    if (column === "changes") return row.after || row.before || null;
    return null;
  });

  if (kind === "requests") {
    if (!logs.requests.length) return <EmptyState icon={Activity} title={t("emptyRequests")} description={t("emptyRequestsHint")} />;
    return (
      <>
        <RowCards label={t("tabs.requests")}>
          {requestRows.map((row) => (
            <RowCard
              key={row.id}
              title={<span className="break-words">{row.model}</span>}
              description={
                <>
                  {time(row.createdAt)}
                  <span className="block font-mono text-xs break-words">{row.endpoint || tCommon("none")}</span>
                </>
              }
              aside={detailButton(row)}
              chips={
                <>
                  {statusChip(row)}
                  {hasChecks(row) ? policyChips(row) : null}
                </>
              }
              details={[
                { label: t("columns.caller"), value: caller(row) },
                { label: t("columns.usage"), value: usage(row) },
                ...(row.labels.length
                  ? [{ label: t("labels.title"), value: <LabelChips labels={row.labels} />, wide: true }]
                  : []),
              ]}
            />
          ))}
        </RowCards>
        <Table aria-label={t("tabs.requests")} className={TABLE_FROM_LG}>
          <Table.ScrollContainer>
            <Table.Content
              aria-label={t("tabs.requests")}
              className="min-w-5xl"
              sortDescriptor={requestSort ? descriptorOf(requestSort) : undefined}
              onSortChange={(descriptor) => setRequestSort(columnSort(descriptor, requestSort))}
            >
              <Table.Header>
                <Table.Column isRowHeader allowsSorting id="model">
                  {({ sortDirection }) => (
                    <Table.SortableColumnHeader sortDirection={sortDirection}>{t("columns.model")}</Table.SortableColumnHeader>
                  )}
                </Table.Column>
                <Table.Column allowsSorting id="time">
                  {({ sortDirection }) => (
                    <Table.SortableColumnHeader sortDirection={sortDirection}>{t("columns.time")}</Table.SortableColumnHeader>
                  )}
                </Table.Column>
                <Table.Column allowsSorting id="caller">
                  {({ sortDirection }) => (
                    <Table.SortableColumnHeader sortDirection={sortDirection}>{t("columns.caller")}</Table.SortableColumnHeader>
                  )}
                </Table.Column>
                <Table.Column allowsSorting id="status">
                  {({ sortDirection }) => (
                    <Table.SortableColumnHeader sortDirection={sortDirection}>{t("columns.status")}</Table.SortableColumnHeader>
                  )}
                </Table.Column>
                <Table.Column allowsSorting id="usage">
                  {({ sortDirection }) => (
                    <Table.SortableColumnHeader sortDirection={sortDirection}>{t("columns.usage")}</Table.SortableColumnHeader>
                  )}
                </Table.Column>
                <Table.Column allowsSorting id="pii">
                  {({ sortDirection }) => (
                    <Table.SortableColumnHeader sortDirection={sortDirection}>{t("columns.pii")}</Table.SortableColumnHeader>
                  )}
                </Table.Column>
                <Table.Column>
                  <span className="sr-only">{tCommon("actions")}</span>
                </Table.Column>
              </Table.Header>
              <Table.Body>
                {requestRows.map((row) => (
                  <Table.Row key={row.id} id={row.id}>
                    <Table.Cell>
                      <div className="max-w-xs min-w-44">
                        <p className="text-sm font-medium break-words">{row.model}</p>
                        <p className="font-mono text-xs break-words text-muted">{row.endpoint || tCommon("none")}</p>
                        {row.labels.length ? (
                          <div className="mt-1">
                            <LabelChips labels={row.labels} />
                          </div>
                        ) : null}
                      </div>
                    </Table.Cell>
                    <Table.Cell>
                      <span className="text-sm whitespace-nowrap text-muted tabular-nums">{time(row.createdAt)}</span>
                    </Table.Cell>
                    <Table.Cell>{caller(row)}</Table.Cell>
                    <Table.Cell>{statusChip(row)}</Table.Cell>
                    <Table.Cell>{usage(row)}</Table.Cell>
                    <Table.Cell>
                      {hasChecks(row) ? <div className="flex flex-wrap gap-1">{policyChips(row)}</div> : null}
                    </Table.Cell>
                    <Table.Cell>{detailButton(row)}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      </>
    );
  }

  if (kind === "spend") {
    if (!logs.spend.length) return <EmptyState icon={Coins} title={t("emptySpend")} description={t("emptySpendHint")} />;
    return (
      <>
        <RowCards label={t("tabs.spend")}>
          {spendRows.map((row) => (
            <RowCard
              key={row.id}
              title={row.model}
              description={time(row.createdAt)}
              details={[
                { label: t("columns.spend"), value: format.number(row.spend, "money") },
                {
                  label: t("columns.tokens"),
                  value: t("tokenSplit", { prompt: row.promptTokens, completion: row.completionTokens }),
                },
              ]}
            />
          ))}
        </RowCards>
        <Table aria-label={t("tabs.spend")} className={TABLE_FROM_LG}>
          <Table.ScrollContainer>
            <Table.Content
              aria-label={t("tabs.spend")}
              sortDescriptor={spendSort ? descriptorOf(spendSort) : undefined}
              onSortChange={(descriptor) => setSpendSort(columnSort(descriptor, spendSort))}
            >
              <Table.Header>
                <Table.Column isRowHeader allowsSorting id="time">
                  {({ sortDirection }) => (
                    <Table.SortableColumnHeader sortDirection={sortDirection}>{t("columns.time")}</Table.SortableColumnHeader>
                  )}
                </Table.Column>
                <Table.Column allowsSorting id="model">
                  {({ sortDirection }) => (
                    <Table.SortableColumnHeader sortDirection={sortDirection}>{t("columns.model")}</Table.SortableColumnHeader>
                  )}
                </Table.Column>
                <Table.Column allowsSorting id="spend">
                  {({ sortDirection }) => (
                    <Table.SortableColumnHeader sortDirection={sortDirection}>{t("columns.spend")}</Table.SortableColumnHeader>
                  )}
                </Table.Column>
                <Table.Column allowsSorting id="tokens">
                  {({ sortDirection }) => (
                    <Table.SortableColumnHeader sortDirection={sortDirection}>{t("columns.tokens")}</Table.SortableColumnHeader>
                  )}
                </Table.Column>
              </Table.Header>
              <Table.Body>
                {spendRows.map((row) => (
                  <Table.Row key={row.id} id={row.id}>
                    <Table.Cell>{time(row.createdAt)}</Table.Cell>
                    <Table.Cell>{row.model}</Table.Cell>
                    <Table.Cell>{format.number(row.spend, "money")}</Table.Cell>
                    <Table.Cell>
                      {t("tokenSplit", { prompt: row.promptTokens, completion: row.completionTokens })}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      </>
    );
  }

  if (!logs.audit.length) return <EmptyState icon={ScrollText} title={t("emptyAudit")} description={t("emptyAuditHint")} />;
  return (
    <>
      <RowCards label={t("tabs.audit")}>
        {auditRows.map((row) => (
          <RowCard
            key={row.id}
            title={row.action}
            description={time(row.createdAt)}
            details={[
              { label: t("columns.actor"), value: row.actor },
              {
                label: t("columns.object"),
                value: t("objectRef", { objectType: row.objectType, objectId: row.objectId }),
              },
              { label: t("columns.changes"), value: changesCell(row), wide: true },
            ]}
          />
        ))}
      </RowCards>
      <Table aria-label={t("tabs.audit")} className={TABLE_FROM_LG}>
        <Table.ScrollContainer>
          <Table.Content
            aria-label={t("tabs.audit")}
            sortDescriptor={auditSort ? descriptorOf(auditSort) : undefined}
            onSortChange={(descriptor) => setAuditSort(columnSort(descriptor, auditSort))}
          >
            <Table.Header>
              <Table.Column isRowHeader allowsSorting id="time">
                {({ sortDirection }) => (
                  <Table.SortableColumnHeader sortDirection={sortDirection}>{t("columns.time")}</Table.SortableColumnHeader>
                )}
              </Table.Column>
              <Table.Column allowsSorting id="actor">
                {({ sortDirection }) => (
                  <Table.SortableColumnHeader sortDirection={sortDirection}>{t("columns.actor")}</Table.SortableColumnHeader>
                )}
              </Table.Column>
              <Table.Column allowsSorting id="action">
                {({ sortDirection }) => (
                  <Table.SortableColumnHeader sortDirection={sortDirection}>{t("columns.action")}</Table.SortableColumnHeader>
                )}
              </Table.Column>
              <Table.Column allowsSorting id="object">
                {({ sortDirection }) => (
                  <Table.SortableColumnHeader sortDirection={sortDirection}>{t("columns.object")}</Table.SortableColumnHeader>
                )}
              </Table.Column>
              <Table.Column allowsSorting id="changes">
                {({ sortDirection }) => (
                  <Table.SortableColumnHeader sortDirection={sortDirection}>{t("columns.changes")}</Table.SortableColumnHeader>
                )}
              </Table.Column>
            </Table.Header>
            <Table.Body>
              {auditRows.map((row) => (
                <Table.Row key={row.id} id={row.id}>
                  <Table.Cell>{time(row.createdAt)}</Table.Cell>
                  <Table.Cell>{row.actor}</Table.Cell>
                  <Table.Cell>{row.action}</Table.Cell>
                  <Table.Cell>
                    {t("objectRef", { objectType: row.objectType, objectId: row.objectId })}
                  </Table.Cell>
                  <Table.Cell>{changesCell(row)}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
    </>
  );
}
