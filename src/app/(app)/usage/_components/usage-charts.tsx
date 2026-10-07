"use client";

import type { ReactNode } from "react";
import { Card } from "@heroui/react";
import { useFormatter, useTranslations } from "next-intl";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import ChartTooltip from "./chart-tooltip";
import type { DailyPoint, ModelPoint, SpendPoint, HealthPoint } from "@/types/usage";

const TICK = { fill: "var(--muted)", fontSize: 12 } as const;
const GRID = { stroke: "var(--border)", vertical: false as const };

function SeriesKey({ colorClass, label }: { colorClass: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      <span aria-hidden className={`h-2 w-2 rounded-full ${colorClass}`} />
      {label}
    </span>
  );
}

function ChartPanel({
  title,
  legend,
  empty,
  emptyLabel,
  children,
  heightClass = "h-56",
}: {
  title: string;
  legend?: ReactNode;
  empty: boolean;
  emptyLabel: string;
  children: ReactNode;
  heightClass?: string;
}) {
  return (
    <Card className="gap-4">
      <Card.Header className="flex-row flex-wrap items-center justify-between gap-2">
        <Card.Title>{title}</Card.Title>
        {legend}
      </Card.Header>
      {empty ? (
        <Card.Description>{emptyLabel}</Card.Description>
      ) : (
        <div className={heightClass}>{children}</div>
      )}
    </Card>
  );
}

function shortName(value: string) {
  return value.length > 18 ? `${value.slice(0, 16)}…` : value;
}

function GroupSpendChart({
  title,
  rows,
  spendLabel,
  emptyLabel,
  formatValue,
  formatTick,
}: {
  title: string;
  rows: SpendPoint[];
  spendLabel: string;
  emptyLabel: string;
  formatValue: (dataKey: string, value: number) => string;
  formatTick: (value: number) => string;
}) {
  if (!rows.length) return null;
  return (
    <ChartPanel title={title} empty={false} emptyLabel={emptyLabel} heightClass="h-72">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          layout="vertical"
          data={rows}
          margin={{ top: 8, right: 16, left: 8, bottom: 8 }}
        >
          <CartesianGrid {...GRID} horizontal={false} vertical />
          <XAxis
            type="number"
            tick={TICK}
            tickLine={false}
            axisLine={false}
            tickFormatter={(value) => formatTick(Number(value))}
          />
          <YAxis
            type="category"
            dataKey="name"
            tick={TICK}
            tickLine={false}
            axisLine={false}
            width={112}
            tickFormatter={shortName}
          />
          <Tooltip
            cursor={{ fill: "var(--foreground)", fillOpacity: 0.04 }}
            content={(props) => (
              <ChartTooltip
                active={props.active}
                payload={props.payload}
                labelText={
                  typeof props.label === "string" ? props.label : undefined
                }
                formatValue={formatValue}
              />
            )}
          />
          <Bar
            dataKey="spend"
            name={spendLabel}
            fill="var(--accent)"
            maxBarSize={22}
            radius={[0, 4, 4, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartPanel>
  );
}

export default function UsageCharts({
  daily,
  byModel,
  byTeam = [],
  byOrg = [],
  byProject = [],
  byMember = [],
  healthByModel = [],
  requests,
  errors,
}: {
  daily: DailyPoint[];
  byModel: ModelPoint[];
  byTeam?: SpendPoint[];
  byOrg?: SpendPoint[];
  byProject?: SpendPoint[];
  byMember?: SpendPoint[];
  healthByModel?: HealthPoint[];
  requests: number;
  errors: number;
}) {
  const t = useTranslations("Usage");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const quiet = daily.every((d) => d.spend === 0 && d.requests === 0);
  const okCount = Math.max(0, requests - errors);
  const requestSeries = daily.map((d) => ({
    ...d,
    ok: Math.max(0, d.requests - d.errors),
  }));
  const modelSeries = byModel.map((row) => ({
    ...row,
    name: row.name || tCommon("none"),
  }));
  const teamSeries = byTeam.map((row) => ({
    name: row.name || tCommon("none"),
    spend: row.spend ?? 0,
  }));
  const orgSeries = byOrg.map((row) => ({
    name: row.name || tCommon("none"),
    spend: row.spend ?? 0,
  }));
  const projectSeries = byProject.map((row) => ({
    name: row.name || tCommon("none"),
    spend: row.spend ?? 0,
  }));
  const memberSeries = byMember.map((row) => ({
    name: row.name || tCommon("none"),
    spend: row.spend ?? 0,
  }));
  const healthSeries = healthByModel.map((row) => ({
    name: row.name || tCommon("none"),
    errors: row.errors ?? 0,
    rate429: row.rate429 ?? 0,
  }));
  const outcomes = [
    { key: "ok", name: t("ok"), value: okCount, fill: "var(--success)" },
    { key: "errors", name: t("metrics.errors"), value: errors, fill: "var(--danger)" },
  ];

  function formatDay(day: string) {
    return format.dateTime(new Date(`${day}T00:00:00`), "chart");
  }

  function formatValue(dataKey: string, value: number) {
    if (dataKey === "spend") return format.number(value, "money");
    return format.number(value, "integer");
  }

  function formatSpendTick(value: number) {
    return format.number(value, "axis");
  }

  return (
    <div className="mt-6 space-y-5">
      <ChartPanel
        title={t("charts.dailySpend")}
        empty={quiet}
        emptyLabel={t("empty")}
      >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={daily} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
            <defs>
              <linearGradient id="usageSpendFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.28} />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid {...GRID} />
            <XAxis
              dataKey="day"
              tick={TICK}
              tickLine={false}
              axisLine={false}
              minTickGap={24}
              tickFormatter={formatDay}
            />
            <YAxis
              tick={TICK}
              tickLine={false}
              axisLine={false}
              width={52}
              tickCount={4}
              tickFormatter={(value) => formatSpendTick(Number(value))}
            />
            <Tooltip
              cursor={{ stroke: "var(--accent)", strokeOpacity: 0.35 }}
              content={(props) => (
                <ChartTooltip
                  active={props.active}
                  payload={props.payload}
                  labelText={
                    props.label != null ? formatDay(String(props.label)) : undefined
                  }
                  formatValue={formatValue}
                />
              )}
            />
            <Area
              type="monotone"
              dataKey="spend"
              name={t("metrics.spend")}
              stroke="var(--accent)"
              strokeWidth={2}
              fill="url(#usageSpendFill)"
              dot={false}
              activeDot={{ r: 4, fill: "var(--accent)", stroke: "var(--surface)" }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </ChartPanel>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <ChartPanel
            title={t("charts.dailyRequests")}
            empty={quiet}
            emptyLabel={t("empty")}
            legend={
              <span className="flex flex-wrap gap-3">
                <SeriesKey colorClass="bg-accent" label={t("ok")} />
                <SeriesKey colorClass="bg-danger" label={t("metrics.errors")} />
              </span>
            }
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={requestSeries}
                margin={{ top: 8, right: 8, left: 4, bottom: 0 }}
                barCategoryGap="18%"
              >
                <CartesianGrid {...GRID} />
                <XAxis
                  dataKey="day"
                  tick={TICK}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={24}
                  tickFormatter={formatDay}
                />
                <YAxis
                  tick={TICK}
                  tickLine={false}
                  axisLine={false}
                  width={40}
                  allowDecimals={false}
                  tickCount={4}
                  tickFormatter={(value) => format.number(Number(value), "integer")}
                />
                <Tooltip
                  cursor={{ fill: "var(--foreground)", fillOpacity: 0.04 }}
                  content={(props) => (
                    <ChartTooltip
                      active={props.active}
                      payload={props.payload}
                      labelText={
                        props.label != null ? formatDay(String(props.label)) : undefined
                      }
                      formatValue={formatValue}
                    />
                  )}
                />
                <Bar
                  dataKey="ok"
                  name={t("ok")}
                  stackId="req"
                  fill="var(--accent)"
                  maxBarSize={36}
                  radius={[0, 0, 0, 0]}
                />
                <Bar
                  dataKey="errors"
                  name={t("metrics.errors")}
                  stackId="req"
                  fill="var(--danger)"
                  maxBarSize={36}
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </ChartPanel>
        </div>
        <div className="lg:col-span-2">
          <ChartPanel
            title={t("charts.outcomes")}
            empty={requests === 0}
            emptyLabel={t("empty")}
            legend={
              <span className="flex flex-wrap gap-3">
                <SeriesKey colorClass="bg-success" label={t("ok")} />
                <SeriesKey colorClass="bg-danger" label={t("metrics.errors")} />
              </span>
            }
            heightClass="h-56"
          >
            <div className="grid h-full grid-cols-2 items-center gap-4">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={outcomes}
                    dataKey="value"
                    nameKey="name"
                    innerRadius="62%"
                    outerRadius="88%"
                    paddingAngle={requests > 0 && errors > 0 ? 2 : 0}
                    stroke="var(--surface)"
                  >
                    {outcomes.map((row) => (
                      <Cell key={row.key} fill={row.fill} />
                    ))}
                  </Pie>
                  <Tooltip
                    content={(props) => (
                      <ChartTooltip
                        active={props.active}
                        payload={props.payload}
                        formatValue={formatValue}
                      />
                    )}
                  />
                </PieChart>
              </ResponsiveContainer>
              <ul className="space-y-3 text-sm">
                <li>
                  <div className="text-xs text-muted">{t("ok")}</div>
                  <div className="font-semibold">{format.number(okCount, "integer")}</div>
                </li>
                <li>
                  <div className="text-xs text-muted">{t("metrics.errors")}</div>
                  <div className="font-semibold">{format.number(errors, "integer")}</div>
                </li>
                <li>
                  <div className="text-xs text-muted">{t("successRate")}</div>
                  <div className="font-semibold">
                    {format.number(requests > 0 ? okCount / requests : 0, "percent")}
                  </div>
                </li>
              </ul>
            </div>
          </ChartPanel>
        </div>
      </div>

      <GroupSpendChart
        title={t("charts.byGroup")}
        rows={modelSeries}
        spendLabel={t("metrics.spend")}
        emptyLabel={t("empty")}
        formatValue={formatValue}
        formatTick={formatSpendTick}
      />
      <GroupSpendChart
        title={t("group.org")}
        rows={orgSeries}
        spendLabel={t("columns.spend")}
        emptyLabel={t("empty")}
        formatValue={formatValue}
        formatTick={formatSpendTick}
      />
      <GroupSpendChart
        title={t("group.team")}
        rows={teamSeries}
        spendLabel={t("columns.spend")}
        emptyLabel={t("empty")}
        formatValue={formatValue}
        formatTick={formatSpendTick}
      />
      <GroupSpendChart
        title={t("group.project")}
        rows={projectSeries}
        spendLabel={t("columns.spend")}
        emptyLabel={t("empty")}
        formatValue={formatValue}
        formatTick={formatSpendTick}
      />
      <GroupSpendChart
        title={t("group.member")}
        rows={memberSeries}
        spendLabel={t("columns.spend")}
        emptyLabel={t("empty")}
        formatValue={formatValue}
        formatTick={formatSpendTick}
      />

      {healthSeries.length ? (
        <ChartPanel
          title={t("metrics.errors")}
          empty={false}
          emptyLabel={t("empty")}
          heightClass="h-72"
          legend={
            <span className="flex flex-wrap gap-3">
              <SeriesKey colorClass="bg-danger" label={t("metrics.errors")} />
              <SeriesKey colorClass="bg-warning" label={t("metrics.rate429")} />
            </span>
          }
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              layout="vertical"
              data={healthSeries}
              margin={{ top: 8, right: 16, left: 8, bottom: 8 }}
            >
              <CartesianGrid {...GRID} horizontal={false} vertical />
              <XAxis
                type="number"
                tick={TICK}
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
                tickFormatter={(value) => format.number(Number(value), "integer")}
              />
              <YAxis
                type="category"
                dataKey="name"
                tick={TICK}
                tickLine={false}
                axisLine={false}
                width={112}
                tickFormatter={shortName}
              />
              <Tooltip
                cursor={{ fill: "var(--foreground)", fillOpacity: 0.04 }}
                content={(props) => (
                  <ChartTooltip
                    active={props.active}
                    payload={props.payload}
                    labelText={
                      typeof props.label === "string" ? props.label : undefined
                    }
                    formatValue={formatValue}
                  />
                )}
              />
              <Bar
                dataKey="errors"
                name={t("metrics.errors")}
                fill="var(--danger)"
                maxBarSize={16}
                radius={[0, 4, 4, 0]}
              />
              <Bar
                dataKey="rate429"
                name={t("metrics.rate429")}
                fill="var(--warning)"
                maxBarSize={16}
                radius={[0, 4, 4, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </ChartPanel>
      ) : null}
    </div>
  );
}
