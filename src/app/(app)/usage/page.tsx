"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import {
  Button,
  buttonVariants,
  Card,
  Label,
  ListBox,
  Select,
  Spinner,
  Table,
} from "@heroui/react";
import { BarChart3, Download } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { loadUsageAction } from "@/app/(app)/_action";
import { isActionFail } from "@/lib/http/action-result";
import EmptyState from "@/components/console/empty-state";
import PageHeader from "@/components/console/page-header";
import StatCard from "@/components/console/stat-card";
import FilterSelect from "./_components/filter-select";
import UsageCharts from "./_components/usage-charts";
import type { SliceRow } from "@/types/gateway";
import type { OkStats, UsageQuery } from "@/types/usage";

const RANGES = [7, 14, 30, 90] as const;

const INITIAL_QUERY: UsageQuery = {
  days: 14,
  model: "",
  teamId: "",
  orgId: "",
  projectId: "",
  memberId: "",
  keyId: "",
  userId: "",
};

function chargebackHref(query: UsageQuery) {
  const params = new URLSearchParams({ days: String(query.days) });
  if (query.model) params.set("model", query.model);
  if (query.teamId) params.set("teamId", query.teamId);
  if (query.orgId) params.set("orgId", query.orgId);
  if (query.projectId) params.set("projectId", query.projectId);
  if (query.memberId) params.set("memberId", query.memberId);
  if (query.keyId) params.set("keyId", query.keyId);
  if (query.userId) params.set("userId", query.userId);
  return `/internal-api/usage/chargeback?${params}`;
}

export default function UsagePage() {
  const t = useTranslations("Usage");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const [loading, setLoading] = useState(true);
  const [pending, start] = useTransition();
  const [query, setQuery] = useState<UsageQuery>(INITIAL_QUERY);
  const [stats, setStats] = useState<OkStats | null>(null);

  const load = useCallback((next: UsageQuery) => {
    start(async () => {
      const res = await loadUsageAction(next);
      if (!isActionFail(res)) setStats(res);
      setLoading(false);
    });
  }, []);

  function apply(patch: Partial<UsageQuery>) {
    const next = { ...query, ...patch };
    setQuery(next);
    load(next);
  }

  useEffect(() => {
    load(INITIAL_QUERY);
  }, [load]);

  if (loading && !stats) {
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

  if (!stats) {
    return (
      <div>
        <PageHeader title={t("title")} subtitle={t("subtitle")} />
        <EmptyState icon={BarChart3} title={t("empty")} />
      </div>
    );
  }

  const label = (id: string) => (id === "unassigned" ? "" : (stats.names[id] ?? id));
  const options = (ids: string[]) => ids.map((id) => ({ id, label: label(id) || id }));
  const named = (rows: SliceRow[]) => rows.map((row) => ({ ...row, name: label(row.name) }));
  const tenantFilters = [
    {
      key: "model" as const,
      label: t("group.model"),
      options: stats.models.map((id) => ({ id, label: id })),
    },
    { key: "orgId" as const, label: t("group.org"), options: options(stats.orgs) },
    { key: "teamId" as const, label: t("group.team"), options: options(stats.teams) },
    { key: "projectId" as const, label: t("group.project"), options: options(stats.projects) },
    { key: "memberId" as const, label: t("group.member"), options: options(stats.members) },
    { key: "keyId" as const, label: t("group.key"), options: options(stats.keys) },
    { key: "userId" as const, label: t("group.user"), options: options(stats.users) },
  ];

  return (
    <div>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              aria-label={t("exportPdf")}
              isPending={pending}
              onPress={() => {
                const link = document.createElement("a");
                const params = new URLSearchParams({ days: String(query.days) });
                if (query.model) params.set("model", query.model);
                link.href = `/internal-api/usage/export?${params}`;
                link.click();
              }}
            >
              <Download size={14} aria-hidden />
              {t("exportPdf")}
            </Button>
            <a href={chargebackHref(query)} className={buttonVariants({ variant: "secondary" })}>
              <Download size={14} aria-hidden />
              {t("chargeback")}
            </a>
          </div>
        }
      />
      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <Select
          selectedKey={String(query.days)}
          onSelectionChange={(key) => {
            apply({ days: Number(key) || 14 });
          }}
          aria-label={t("range")}
          fullWidth
        >
          <Label>{t("range")}</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox aria-label={t("range")}>
              {RANGES.map((n) => (
                <ListBox.Item key={String(n)} id={String(n)} textValue={t("days", { n })}>
                  {t("days", { n })}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
        {tenantFilters.map((filter) => (
          <FilterSelect
            key={filter.key}
            label={filter.label}
            value={query[filter.key]}
            options={filter.options}
            allLabel={tCommon("all")}
            onChange={(next) => apply({ [filter.key]: next })}
          />
        ))}
      </div>
      <p className="sr-only">
        {t("summary", {
          spend: stats.spend,
          count: stats.count,
          errors: stats.errors,
        })}
      </p>
      <div
        aria-busy={pending}
        className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7"
      >
        {(
          [
            ["spend", t("metrics.spend"), format.number(stats.spend, "money")],
            ["tokens", t("metrics.tokens"), format.number(stats.tokens, "integer")],
            ["requests", t("metrics.requests"), format.number(stats.count, "integer")],
            ["errors", t("metrics.errors"), format.number(stats.errors, "integer")],
            [
              "latency",
              t("metrics.latency"),
              t("latencyValue", { ms: Math.round(stats.latency) }),
            ],
            [
              "rate429",
              t("metrics.rate429"),
              format.number(stats.rate429, "integer"),
            ],
            [
              "p95",
              t("metrics.p95"),
              t("latencyValue", { ms: Math.round(stats.p95Latency) }),
            ],
          ] as const
        ).map(([key, label, value]) => (
          <StatCard key={key} label={label} value={value} />
        ))}
      </div>
      <UsageCharts
        daily={stats.daily}
        byModel={stats.byModel}
        byTeam={named(stats.byTeam)}
        byOrg={named(stats.byOrg)}
        byProject={named(stats.byProject)}
        byMember={named(stats.byMember)}
        healthByModel={stats.healthByModel}
        requests={stats.count}
        errors={stats.errors}
      />
      {stats.byModel.length ? (
        <Card className="mt-5 gap-4">
          <Card.Header>
            <Card.Title>{t("pdf.byModel")}</Card.Title>
          </Card.Header>
          <Table aria-label={t("pdf.byModel")}>
            <Table.ScrollContainer>
              <Table.Content>
                <Table.Header>
                  <Table.Column isRowHeader>{t("columns.name")}</Table.Column>
                  <Table.Column>{t("columns.spend")}</Table.Column>
                  <Table.Column>{t("columns.prompt")}</Table.Column>
                  <Table.Column>{t("columns.completion")}</Table.Column>
                </Table.Header>
                <Table.Body>
                  {stats.byModel.map((row) => (
                    <Table.Row key={row.name || "none"} id={row.name || "none"}>
                      <Table.Cell>{row.name || tCommon("none")}</Table.Cell>
                      <Table.Cell>{format.number(row.spend, "money")}</Table.Cell>
                      <Table.Cell>
                        {format.number(row.prompt, "integer")}
                      </Table.Cell>
                      <Table.Cell>
                        {format.number(row.completion, "integer")}
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        </Card>
      ) : null}
    </div>
  );
}
