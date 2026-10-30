"use client";

import { Button, Table } from "@heroui/react";
import { Activity, Coins, FileText, ScrollText } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { Link } from "@/i18n/routing";
import EmptyState from "@/components/console/empty-state";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import type { loadLogsAction } from "../_action";
import type { LogKind, RequestLogRow } from "@/types/logs";
import GuardrailChip from "./guardrail-chip";
import LabelChips from "./label-chips";
import PiiChip from "./pii-chip";
import StatusChip from "./status-chip";

function guarded(row: RequestLogRow): boolean {
  return row.outcome === "guardrail_blocked" || row.guardInput.length > 0 || row.guardOutput.length > 0;
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

  if (kind === "requests") {
    if (!logs.requests.length) return <EmptyState icon={Activity} title={t("emptyRequests")} description={t("emptyRequestsHint")} />;
    return (
      <>
        <RowCards label={t("tabs.requests")}>
          {logs.requests.map((row) => (
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
            <Table.Content aria-label={t("tabs.requests")} className="min-w-5xl">
              <Table.Header>
                <Table.Column isRowHeader>{t("columns.model")}</Table.Column>
                <Table.Column>{t("columns.time")}</Table.Column>
                <Table.Column>{t("columns.caller")}</Table.Column>
                <Table.Column>{t("columns.status")}</Table.Column>
                <Table.Column>{t("columns.usage")}</Table.Column>
                <Table.Column>{t("columns.pii")}</Table.Column>
                <Table.Column>
                  <span className="sr-only">{tCommon("actions")}</span>
                </Table.Column>
              </Table.Header>
              <Table.Body>
                {logs.requests.map((row) => (
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
          {logs.spend.map((row) => (
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
            <Table.Content aria-label={t("tabs.spend")}>
              <Table.Header>
                <Table.Column isRowHeader>{t("columns.time")}</Table.Column>
                <Table.Column>{t("columns.model")}</Table.Column>
                <Table.Column>{t("columns.spend")}</Table.Column>
                <Table.Column>{t("columns.tokens")}</Table.Column>
              </Table.Header>
              <Table.Body>
                {logs.spend.map((row) => (
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
        {logs.audit.map((row) => (
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
          <Table.Content aria-label={t("tabs.audit")}>
            <Table.Header>
              <Table.Column isRowHeader>{t("columns.time")}</Table.Column>
              <Table.Column>{t("columns.actor")}</Table.Column>
              <Table.Column>{t("columns.action")}</Table.Column>
              <Table.Column>{t("columns.object")}</Table.Column>
              <Table.Column>{t("columns.changes")}</Table.Column>
            </Table.Header>
            <Table.Body>
              {logs.audit.map((row) => (
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
