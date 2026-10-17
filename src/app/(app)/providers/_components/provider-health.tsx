"use client";

import { useEffect, useState } from "react";
import { Button, Card, Chip, Label, ListBox, Select, Spinner, Switch, Table } from "@heroui/react";
import { Activity, CircleCheck, HeartPulse, RefreshCw, Send, Snowflake, TriangleAlert } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import EmptyState from "@/components/console/empty-state";
import SubscriptionBadge from "@/components/console/subscription-badge";
import { isSignInKind } from "@/lib/gateway/upstreams/provider-kinds";
import { LoadError, PageLoading } from "@/components/console/page-status";
import StatCard from "@/components/console/stat-card";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import { Link } from "@/i18n/routing";
import { useActionData } from "@/lib/hooks/use-action-data";
import { isActionFail } from "@/lib/http/action-result";
import type { DeploymentHealthView } from "@/types/provider-health";
import { loadProviderHealthAction } from "../_action";

const WINDOWS = [5, 15, 60] as const;
const DEFAULT_WINDOW = 15;
const POLL_MS = 15_000;

type RouteState = "cooling" | "degraded" | "healthy" | "idle";

function routeState(row: DeploymentHealthView): RouteState {
  if (row.cooldownUntil) return "cooling";
  if (row.failures) return "degraded";
  if (row.attempts) return "healthy";
  return "idle";
}

const STATE_COLOR = {
  cooling: "warning",
  degraded: "danger",
  healthy: "success",
  idle: "default",
} as const satisfies Record<RouteState, "warning" | "danger" | "success" | "default">;

export default function ProviderHealth() {
  const t = useTranslations("ProviderHealth");
  const tProviders = useTranslations("Providers");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const [minutes, setMinutes] = useState<number>(DEFAULT_WINDOW);
  const [showIdle, setShowIdle] = useState(false);
  const health = useActionData(() => loadProviderHealthAction(DEFAULT_WINDOW));
  const { data: report, setData: setReport, pending } = health;

  function refresh(span: number) {
    health.reloadWith(() => loadProviderHealthAction(span));
  }

  useEffect(() => {
    let active = true;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      loadProviderHealthAction(minutes).then((res) => {
        if (active && !isActionFail(res)) setReport(res);
      });
    }, POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [minutes, setReport]);

  if (!report) {
    return health.error === null ? <PageLoading /> : <LoadError state={health} />;
  }

  const active = report.deployments.filter((row) => row.attempts > 0 || row.cooldownUntil);
  const visible = showIdle ? report.deployments : active;
  const cooling = report.deployments.filter((row) => row.cooldownUntil).length;
  const attempts = report.deployments.reduce((sum, row) => sum + row.attempts, 0);
  const failures = report.deployments.reduce((sum, row) => sum + row.failures, 0);
  const latency = (ms: number | null) => (ms === null ? "—" : t("latencyValue", { ms: Math.round(ms) }));
  const readyNote = (row: DeploymentHealthView) =>
    row.cooldownUntil
      ? t("ready", { when: format.relativeTime(new Date(row.cooldownUntil), new Date(report.generatedAt)) })
      : null;

  function stateChip(row: DeploymentHealthView) {
    const state = routeState(row);
    return (
      <Chip size="sm" variant="soft" color={STATE_COLOR[state]} className="whitespace-nowrap">
        {t("state", { state })}
      </Chip>
    );
  }

  function providerCell(row: DeploymentHealthView) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <span>
          {row.provider || tProviders(isSignInKind(row.kind) ? "kindShort" : "kindName", { kind: row.kind })}
        </span>
        {isSignInKind(row.kind) ? <SubscriptionBadge /> : null}
      </span>
    );
  }

  function errorRate(row: DeploymentHealthView) {
    return row.attempts ? format.number(row.errorRate, "percent") : "—";
  }

  if (report.deployments.length === 0) {
    return (
      <EmptyState
        icon={HeartPulse}
        title={t("emptyTitle")}
        description={t("empty")}
        action={
          <Link href="/models" className="text-sm font-medium text-accent">
            {t("openModels")}
          </Link>
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      <LoadError state={health} />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="min-w-0 flex-1 basis-64 text-sm text-muted">
          {t("subtitle", { seconds: Math.round(report.cooldownMs / 1000) })}
        </p>
        <div className="flex w-full flex-wrap items-end gap-2 sm:w-auto">
          <div className="w-full sm:w-48">
            <Select
              selectedKey={String(minutes)}
              onSelectionChange={(key) => {
                const next = Number(key) || DEFAULT_WINDOW;
                setMinutes(next);
                refresh(next);
              }}
              aria-label={t("window")}
              fullWidth
            >
              <Label>{t("window")}</Label>
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox aria-label={t("window")}>
                  {WINDOWS.map((n) => (
                    <ListBox.Item key={String(n)} id={String(n)} textValue={t("lastMinutes", { n })}>
                      {t("lastMinutes", { n })}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
          </div>
          <Button variant="secondary" isPending={pending} onPress={() => refresh(minutes)}>
            {({ isPending }) => (
              <>
                {isPending ? <Spinner size="sm" color="current" /> : <RefreshCw size={14} aria-hidden />}
                {tCommon("refresh")}
              </>
            )}
          </Button>
        </div>
      </div>

      <div aria-busy={pending} className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard
          icon={Activity}
          tone="accent"
          label={t("metrics.active")}
          value={t("activeValue", { active: active.length, total: report.deployments.length })}
        />
        <StatCard
          icon={Snowflake}
          tone={cooling ? "warning" : "neutral"}
          label={t("metrics.cooling")}
          value={format.number(cooling, "integer")}
        />
        <StatCard
          icon={Send}
          tone="accent"
          label={t("metrics.attempts")}
          value={format.number(attempts, "integer")}
          hint={t("backend", { backend: report.backend })}
        />
        <StatCard
          icon={failures ? TriangleAlert : CircleCheck}
          tone={failures ? "danger" : "success"}
          label={t("metrics.errorRate")}
          value={attempts ? format.number(failures / attempts, "percent") : "—"}
        />
      </div>

      <Card className="gap-4">
        <Card.Header className="flex-row flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 basis-64">
            <Card.Title>{t("endpoints")}</Card.Title>
            <Card.Description>
              {t("updated", { n: report.minutes, time: format.dateTime(report.generatedAt, "time") })}
            </Card.Description>
            <Card.Description>{t("latencyNote")}</Card.Description>
          </div>
          <Switch size="sm" isSelected={showIdle} onChange={setShowIdle}>
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              <Label>{t("showIdle", { n: report.deployments.length - active.length })}</Label>
            </Switch.Content>
          </Switch>
        </Card.Header>
        {visible.length ? (
          <RowCards label={t("endpoints")}>
            {visible.map((row) => (
              <RowCard
                key={row.id}
                variant="secondary"
                title={row.alias}
                description={row.model}
                aside={stateChip(row)}
                details={[
                  { label: t("columns.provider"), value: providerCell(row), wide: true },
                  ...(row.cooldownUntil ? [{ label: tCommon("status"), value: readyNote(row), wide: true }] : []),
                  { label: t("columns.attempts"), value: format.number(row.attempts, "integer") },
                  {
                    label: t("columns.errorRate"),
                    value: <span className={row.failures ? "text-danger" : undefined}>{errorRate(row)}</span>,
                  },
                  { label: t("columns.p50"), value: latency(row.p50) },
                  { label: t("columns.p95"), value: latency(row.p95) },
                  {
                    label: t("columns.trips"),
                    value: (
                      <span className={row.trips ? "text-warning" : undefined}>
                        {format.number(row.trips, "integer")}
                      </span>
                    ),
                  },
                ]}
              />
            ))}
          </RowCards>
        ) : (
          <p className="py-6 text-center text-sm text-muted lg:hidden">{t("quiet", { n: report.minutes })}</p>
        )}
        <Table className={TABLE_FROM_LG}>
          <Table.ScrollContainer>
            <Table.Content aria-label={t("endpoints")} className="min-w-4xl">
              <Table.Header>
                <Table.Column isRowHeader>{t("columns.model")}</Table.Column>
                <Table.Column>{t("columns.provider")}</Table.Column>
                <Table.Column>{tCommon("status")}</Table.Column>
                <Table.Column>{t("columns.attempts")}</Table.Column>
                <Table.Column>{t("columns.errorRate")}</Table.Column>
                <Table.Column>{t("columns.p50")}</Table.Column>
                <Table.Column>{t("columns.p95")}</Table.Column>
                <Table.Column>{t("columns.trips")}</Table.Column>
              </Table.Header>
              <Table.Body
                renderEmptyState={() => (
                  <p className="py-6 text-center text-sm text-muted">{t("quiet", { n: report.minutes })}</p>
                )}
              >
                {visible.map((row) => (
                  <Table.Row key={row.id} id={row.id}>
                    <Table.Cell>
                      <div className="font-medium">{row.alias}</div>
                      <div className="text-xs text-muted">{row.model}</div>
                    </Table.Cell>
                    <Table.Cell>{providerCell(row)}</Table.Cell>
                    <Table.Cell>
                      {stateChip(row)}
                      {row.cooldownUntil ? <div className="mt-1 text-xs text-muted">{readyNote(row)}</div> : null}
                    </Table.Cell>
                    <Table.Cell>{format.number(row.attempts, "integer")}</Table.Cell>
                    <Table.Cell className={row.failures ? "text-danger" : undefined}>{errorRate(row)}</Table.Cell>
                    <Table.Cell>{latency(row.p50)}</Table.Cell>
                    <Table.Cell>{latency(row.p95)}</Table.Cell>
                    <Table.Cell className={row.trips ? "text-warning" : undefined}>
                      {format.number(row.trips, "integer")}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      </Card>
    </div>
  );
}
