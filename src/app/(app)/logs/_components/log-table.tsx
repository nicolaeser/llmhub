"use client";

import { Button, Chip, Table } from "@heroui/react";
import { Activity, FileText } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import EmptyState from "@/components/console/empty-state";
import type { loadLogsAction } from "../_action";
import type { Kind, RequestLogRow } from "@/types/logs";
import PiiChip from "./pii-chip";

export type LogsPayload = Exclude<Awaited<ReturnType<typeof loadLogsAction>>, { ok: false }>;

export default function LogTable({
  kind,
  logs,
  onOpen,
}: {
  kind: Kind;
  logs: LogsPayload;
  onOpen: (row: RequestLogRow) => void;
}) {
  const t = useTranslations("Logs");
  const tCommon = useTranslations("Common");
  const format = useFormatter();

  function time(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : format.dateTime(date, "dateTime");
  }

  if (kind === "requests") {
    if (!logs.requests.length) return <EmptyState icon={Activity} title={t("emptyRequests")} />;
    return (
      <Table aria-label={t("tabs.requests")}>
        <Table.ScrollContainer>
          <Table.Content className="min-w-6xl">
            <Table.Header>
              <Table.Column isRowHeader>{t("columns.time")}</Table.Column>
              <Table.Column>{t("columns.model")}</Table.Column>
              <Table.Column>{t("columns.caller")}</Table.Column>
              <Table.Column>{t("columns.status")}</Table.Column>
              <Table.Column>{t("columns.latency")}</Table.Column>
              <Table.Column>{t("columns.tokens")}</Table.Column>
              <Table.Column>{t("columns.cost")}</Table.Column>
              <Table.Column>{t("columns.pii")}</Table.Column>
              <Table.Column>{tCommon("actions")}</Table.Column>
            </Table.Header>
            <Table.Body>
              {logs.requests.map((row) => (
                <Table.Row key={row.id} id={row.id}>
                  <Table.Cell>{time(row.createdAt)}</Table.Cell>
                  <Table.Cell>
                    <p className="text-sm">{row.model}</p>
                    <p className="font-mono text-xs text-muted">{row.endpoint || tCommon("none")}</p>
                  </Table.Cell>
                  <Table.Cell>
                    <p className="text-sm">{row.keyLabel || t("caller.noKey")}</p>
                    <p className="text-xs text-muted">{row.userLabel || row.userId || tCommon("none")}</p>
                  </Table.Cell>
                  <Table.Cell>
                    <Chip size="sm" variant="soft" color={row.status >= 400 ? "danger" : "default"} className="whitespace-nowrap">
                      {t("statusOutcome", { status: row.status, outcome: row.outcome })}
                    </Chip>
                  </Table.Cell>
                  <Table.Cell>{t("latencyMs", { value: row.latencyMs })}</Table.Cell>
                  <Table.Cell>
                    {t("tokenSplit", { prompt: row.promptTokens, completion: row.completionTokens })}
                  </Table.Cell>
                  <Table.Cell>{format.number(row.cost, "money")}</Table.Cell>
                  <Table.Cell>
                    <PiiChip
                      outcome={row.outcome}
                      piiMode={row.piiMode}
                      piiInput={row.piiInput}
                      piiOutput={row.piiOutput}
                    />
                  </Table.Cell>
                  <Table.Cell>
                    <Button
                      isIconOnly
                      size="sm"
                      variant="ghost"
                      aria-label={t("openDetails", { model: row.model })}
                      onPress={() => onOpen(row)}
                    >
                      <FileText size={14} aria-hidden />
                    </Button>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
    );
  }

  if (kind === "spend") {
    if (!logs.spend.length) return <EmptyState icon={Activity} title={t("emptySpend")} />;
    return (
      <Table aria-label={t("tabs.spend")}>
        <Table.ScrollContainer>
          <Table.Content>
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
    );
  }

  if (!logs.audit.length) return <EmptyState icon={Activity} title={t("emptyAudit")} />;
  return (
    <Table aria-label={t("tabs.audit")}>
      <Table.ScrollContainer>
        <Table.Content>
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
                <Table.Cell>
                  <code
                    title={[row.before, row.after].filter(Boolean).join("\n")}
                    className="line-clamp-2 max-w-md font-mono text-xs break-all text-muted"
                  >
                    {row.after || row.before || "—"}
                  </code>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Content>
      </Table.ScrollContainer>
    </Table>
  );
}
