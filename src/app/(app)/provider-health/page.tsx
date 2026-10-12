"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import {
  Button,
  Card,
  Chip,
  Label,
  ListBox,
  Select,
  Spinner,
  Switch,
  Table,
} from "@heroui/react";
import { HeartPulse, RefreshCw } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { Link } from "@/i18n/routing";
import { loadProviderHealthAction } from "@/app/(app)/provider-health/_action";
import { isActionFail } from "@/lib/http/action-result";
import EmptyState from "@/components/console/empty-state";
import PageHeader from "@/components/console/page-header";
import StatCard from "@/components/console/stat-card";
import type { ActionFail } from "@/types/actions";
import type { DeploymentHealthView, HealthReport } from "@/types/provider-health";

const WINDOWS = [5, 15, 60] as const;
const POLL_MS = 15_000;

type RouteState = "cooling" | "degraded" | "healthy" | "idle";

function routeState(row: DeploymentHealthView): RouteState {
  if (row.cooldownUntil) return "cooling";
  if (row.failures) return "degraded";
  if (row.attempts) return "healthy";
  return "idle";
}

const STATE_COLOR = {
  cooling: "danger",
  degraded: "warning",
  healthy: "success",
  idle: "default",
} as const;

export default function ProviderHealthPage() {
  const t = useTranslations("ProviderHealth");
  const tProviders = useTranslations("Providers");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const [report, setReport] = useState<HealthReport | null>(null);
  const [failed, setFailed] = useState(false);
  const [minutes, setMinutes] = useState<number>(15);
  const [showIdle, setShowIdle] = useState(false);
  const [pending, start] = useTransition();

  const receive = useCallback((res: HealthReport | ActionFail) => {
    if (isActionFail(res)) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setReport(res);
  }, []);

  const refresh = useCallback(
    (span: number) => {
      start(async () => receive(await loadProviderHealthAction(span)));
    },
    [receive],
  );

  useEffect(() => {
    refresh(15);
  }, [refresh]);

  useEffect(() => {
    let active = true;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      loadProviderHealthAction(minutes).then((res) => {
        if (active) receive(res);
      });
    }, POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [minutes, receive]);

  if (!report && !failed) {
    return (
      <output
        aria-live="polite"
        aria-label={tCommon("loading")}
        className="flex min-h-[40vh] items-center justify-center text-accent"
      >
        <Spinner color="current" size="lg" />
      </output>
    );
  }

  if (!report) {
    return (
      <div>
        <PageHeader title={t("title")} subtitle={t("subtitle")} />
        <EmptyState
          icon={HeartPulse}
          title={t("loadFailed")}
          action={
            <Button variant="secondary" isPending={pending} onPress={() => refresh(minutes)}>
              {({ isPending }) => (
                <>
                  {isPending ? <Spinner size="sm" color="current" /> : <RefreshCw size={14} aria-hidden />}
                  {tCommon("refresh")}
                </>
              )}
            </Button>
          }
        />
      </div>
    );
  }

  const active = report.deployments.filter((row) => row.attempts > 0 || row.cooldownUntil);
  const visible = showIdle ? report.deployments : active;
  const cooling = report.deployments.filter((row) => row.cooldownUntil).length;
  const attempts = report.deployments.reduce((sum, row) => sum + row.attempts, 0);
  const failures = report.deployments.reduce((sum, row) => sum + row.failures, 0);
  const latency = (ms: number | null) => (ms === null ? "—" : t("latencyValue", { ms: Math.round(ms) }));

  return (
    <div>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle", { seconds: Math.round(report.cooldownMs / 1000) })}
      />

      {report.deployments.length === 0 ? (
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
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-end gap-3">
            <div className="w-full sm:w-64">
              <Select
                selectedKey={String(minutes)}
                onSelectionChange={(key) => {
                  const next = Number(key) || 15;
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
            <div className="flex h-10 items-center">
              <Chip
                size="sm"
                variant="soft"
                color={report.backend === "redis" ? "success" : "default"}
                className="whitespace-nowrap"
              >
                {t("backend", { backend: report.backend })}
              </Chip>
            </div>
          </div>

          <div aria-busy={pending} className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard
              label={t("metrics.active")}
              value={t("activeValue", { active: active.length, total: report.deployments.length })}
            />
            <StatCard label={t("metrics.cooling")} value={format.number(cooling, "integer")} />
            <StatCard label={t("metrics.attempts")} value={format.number(attempts, "integer")} />
            <StatCard
              label={t("metrics.errorRate")}
              value={attempts ? format.number(failures / attempts, "percent") : "—"}
            />
          </div>

          <Card className="gap-4">
            <Card.Header className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <Card.Title>{t("endpoints")}</Card.Title>
                <Card.Description>
                  {t("updated", {
                    n: report.minutes,
                    time: format.dateTime(report.generatedAt, "time"),
                  })}
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
            <Table>
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
                    {visible.map((row) => {
                      const state = routeState(row);
                      return (
                        <Table.Row key={row.id} id={row.id}>
                          <Table.Cell>
                            <div className="font-medium">{row.alias}</div>
                            <div className="text-xs text-muted">{row.model}</div>
                          </Table.Cell>
                          <Table.Cell>{row.provider || tProviders("kindName", { kind: row.kind })}</Table.Cell>
                          <Table.Cell>
                            <Chip size="sm" variant="soft" color={STATE_COLOR[state]} className="whitespace-nowrap">
                              {t("state", { state })}
                            </Chip>
                            {row.cooldownUntil ? (
                              <div className="mt-1 text-xs text-muted">
                                {t("ready", {
                                  when: format.relativeTime(new Date(row.cooldownUntil), new Date(report.generatedAt)),
                                })}
                              </div>
                            ) : null}
                          </Table.Cell>
                          <Table.Cell>{format.number(row.attempts, "integer")}</Table.Cell>
                          <Table.Cell>{row.attempts ? format.number(row.errorRate, "percent") : "—"}</Table.Cell>
                          <Table.Cell>{latency(row.p50)}</Table.Cell>
                          <Table.Cell>{latency(row.p95)}</Table.Cell>
                          <Table.Cell>{format.number(row.trips, "integer")}</Table.Cell>
                        </Table.Row>
                      );
                    })}
                  </Table.Body>
                </Table.Content>
              </Table.ScrollContainer>
            </Table>
          </Card>
        </>
      )}
    </div>
  );
}
