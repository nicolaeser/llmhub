"use client";

import { useId, type ReactNode } from "react";
import { Button, Card, Chip, Meter, Skeleton, Table } from "@heroui/react";
import { Activity, ArrowLeftRight, Coins, FileText, Timer } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { SectionLoading } from "@/components/console/page-status";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import StatCard from "@/components/console/stat-card";
import type { LogSessionDetail, LogSessionRequest } from "@/types/logs";
import { useCallerLabels, useCompactTokens } from "./session-cells";
import { useSessionFormat } from "./session-format";
import StatusChip from "./status-chip";

function Field({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? "min-w-0 sm:col-span-2 lg:col-span-4" : "min-w-0"}>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-sm break-words text-foreground">{children}</dd>
    </div>
  );
}

export default function SessionTrace({
  data,
  pending,
  onPage,
  onOpenRequest,
}: {
  data: LogSessionDetail;
  pending: boolean;
  onPage: (page: number) => void;
  onOpenRequest: (id: string) => void;
}) {
  const t = useTranslations("Logs");
  const tSessions = useTranslations("Logs.sessions");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const session = useSessionFormat();
  const caller = useCallerLabels();
  const tokens = useCompactTokens();
  const timelineId = useId();
  const page = data.page;

  function latency(row: LogSessionRequest, slowest: number) {
    const share = slowest > 0 ? row.latencyMs / slowest : 0;
    return (
      <div className="w-32 space-y-1.5">
        <span className="block text-sm tabular-nums">{t("latencyMs", { value: row.latencyMs })}</span>
        <Meter
          size="sm"
          value={share * 100}
          color={row.status >= 400 ? "warning" : "accent"}
          aria-label={t("columns.latency")}
          valueLabel={tSessions("latencyShare", { rate: share })}
        >
          <Meter.Track>
            <Meter.Fill />
          </Meter.Track>
        </Meter>
      </div>
    );
  }

  function account(detail: LogSessionDetail, row: LogSessionRequest) {
    if (!row.account) return tCommon("none");
    const known = detail.accounts.find((item) => item.index === row.account);
    return (
      <>
        <span className="block break-words">{known?.label || tSessions("account", { index: row.account })}</span>
        {known?.provider ? <span className="block text-xs text-muted">{known.provider}</span> : null}
      </>
    );
  }

  function chips(row: LogSessionRequest) {
    return (
      <>
        <StatusChip status={row.status} outcome={row.outcome} />
        {row.accountSwitch ? (
          <Chip size="sm" variant="soft" color="warning" className="whitespace-nowrap">
            <ArrowLeftRight size={12} aria-hidden />
            {tSessions("switched")}
          </Chip>
        ) : null}
      </>
    );
  }

  function detailButton(row: LogSessionRequest) {
    return (
      <Button
        isIconOnly
        size="sm"
        variant="ghost"
        aria-label={t("openDetails", { model: row.model })}
        onPress={() => onOpenRequest(row.id)}
      >
        <FileText size={14} aria-hidden />
      </Button>
    );
  }

  const summary = data.session;
  const first = (page - 1) * data.pageSize + 1;
  const last = Math.min(data.total, page * data.pageSize);
  const slowest = Math.max(0, ...data.requests.map((row) => row.latencyMs));

  return (
    <div className="space-y-5">
      <Card>
        <Card.Content>
          <dl className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={t("columns.caller")}>
              {caller.key(summary)}
              <span className="block text-xs text-muted">{caller.person(summary)}</span>
            </Field>
            <Field label={t("detail.agent")}>
              {summary.agent ? t("agent", { agent: summary.agent }) : tCommon("none")}
            </Field>
            <Field label={tSessions("inputTokens")}>{format.number(summary.promptTokens, "integer")}</Field>
            <Field label={tSessions("outputTokens")}>{format.number(summary.completionTokens, "integer")}</Field>
            <Field label={tSessions("cacheRead")}>{format.number(summary.cacheReadTokens, "integer")}</Field>
            <Field label={tSessions("cacheWritten")}>{format.number(summary.cacheWriteTokens, "integer")}</Field>
            <Field label={tSessions("columns.models")} wide>
              {summary.models.length ? (
                <span className="mt-1 flex flex-wrap gap-1">
                  {summary.models.map((model) => (
                    <Chip key={model.model} size="sm" variant="soft">
                      {tSessions("modelLine", {
                        model: model.model,
                        count: model.requests,
                      })}
                    </Chip>
                  ))}
                </span>
              ) : (
                tCommon("none")
              )}
            </Field>
          </dl>
        </Card.Content>
      </Card>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={tSessions("columns.requests")}
          value={format.number(summary.requests, "integer")}
          icon={Activity}
          tone={summary.errors ? "danger" : "accent"}
          hint={tSessions("errorCount", { count: summary.errors })}
        />
        <StatCard label={t("columns.cost")} value={format.number(summary.cost, "money")} icon={Coins} />
        <StatCard
          label={tSessions("columns.duration")}
          value={session.duration(summary.durationMs)}
          icon={Timer}
          tone="neutral"
        />
        <StatCard
          label={tSessions("columns.switches")}
          value={format.number(summary.accountSwitches, "integer")}
          icon={ArrowLeftRight}
          tone={summary.accountSwitches ? "warning" : "neutral"}
          hint={tSessions("accountCount", { count: summary.accounts })}
        />
      </div>
      <section className="space-y-3" aria-labelledby={timelineId}>
        <h2 id={timelineId} className="text-sm font-semibold">
          {tSessions("timeline")}
        </h2>
        {pending ? (
          <SectionLoading shape="table" rows={8} />
        ) : (
          <>
            <RowCards label={tSessions("timeline")}>
              {data.requests.map((row) => (
                <RowCard
                  key={row.id}
                  title={row.model}
                  description={
                    <>
                      {format.dateTime(new Date(row.createdAt), "zoned")}
                      <span className="block font-mono text-xs">{session.offset(row.offsetMs)}</span>
                    </>
                  }
                  aside={detailButton(row)}
                  chips={chips(row)}
                  details={[
                    {
                      label: tSessions("columns.account"),
                      value: account(data, row),
                    },
                    {
                      label: t("columns.latency"),
                      value: latency(row, slowest),
                    },
                    {
                      label: t("columns.tokens"),
                      value: tokens(row.promptTokens, row.completionTokens),
                    },
                    {
                      label: t("columns.cost"),
                      value: format.number(row.cost, "money"),
                    },
                  ]}
                />
              ))}
            </RowCards>
            <Table aria-label={tSessions("timeline")} className={TABLE_FROM_LG}>
              <Table.ScrollContainer>
                <Table.Content aria-label={tSessions("timeline")} className="min-w-6xl">
                  <Table.Header>
                    <Table.Column isRowHeader>{t("columns.time")}</Table.Column>
                    <Table.Column>{tSessions("columns.offset")}</Table.Column>
                    <Table.Column>{t("columns.model")}</Table.Column>
                    <Table.Column>{tSessions("columns.account")}</Table.Column>
                    <Table.Column>{t("columns.status")}</Table.Column>
                    <Table.Column>{t("columns.latency")}</Table.Column>
                    <Table.Column>{t("columns.tokens")}</Table.Column>
                    <Table.Column>{t("columns.cost")}</Table.Column>
                    <Table.Column>{tCommon("actions")}</Table.Column>
                  </Table.Header>
                  <Table.Body>
                    {data.requests.map((row) => (
                      <Table.Row key={row.id} id={row.id}>
                        <Table.Cell>
                          <time
                            dateTime={row.createdAt}
                            title={format.dateTime(new Date(row.createdAt), "zoned")}
                            className="whitespace-nowrap tabular-nums"
                          >
                            {format.dateTime(new Date(row.createdAt), "time")}
                          </time>
                        </Table.Cell>
                        <Table.Cell>
                          <span className="font-mono text-xs">{session.offset(row.offsetMs)}</span>
                        </Table.Cell>
                        <Table.Cell>
                          <p className="text-sm whitespace-nowrap">{row.model}</p>
                          <p className="font-mono text-xs whitespace-nowrap text-muted">
                            {row.endpoint || tCommon("none")}
                          </p>
                        </Table.Cell>
                        <Table.Cell>
                          <div className="text-sm">{account(data, row)}</div>
                        </Table.Cell>
                        <Table.Cell>
                          <div className="flex flex-wrap gap-1">{chips(row)}</div>
                        </Table.Cell>
                        <Table.Cell>{latency(row, slowest)}</Table.Cell>
                        <Table.Cell>
                          <span className="whitespace-nowrap tabular-nums">
                            {tokens(row.promptTokens, row.completionTokens)}
                          </span>
                        </Table.Cell>
                        <Table.Cell>{format.number(row.cost, "money")}</Table.Cell>
                        <Table.Cell>{detailButton(row)}</Table.Cell>
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
              {tSessions("timelineStatus", {
                from: first,
                to: last,
                total: data.total,
              })}
            </p>
          )}
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              isDisabled={page <= 1}
              isPending={pending}
              onPress={() => onPage(page - 1)}
            >
              {t("prev")}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              isDisabled={page * data.pageSize >= data.total}
              isPending={pending}
              onPress={() => onPage(page + 1)}
            >
              {t("next")}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
