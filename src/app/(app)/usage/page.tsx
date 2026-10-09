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
import SearchSelect from "@/components/console/search-select";
import StatCard from "@/components/console/stat-card";
import UsageCharts from "./_components/usage-charts";
import type { PickerItem } from "@/types/console";
import type { SliceRow } from "@/types/gateway";
import type { OkStats, UsageQuery } from "@/types/usage";

const RANGES = [7, 14, 30, 90] as const;

type TenantGroup = "org" | "team" | "project" | "member" | "key" | "user";

type FilterKey = Exclude<keyof UsageQuery, "days">;

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
  const [picked, setPicked] = useState<Partial<Record<FilterKey, PickerItem>>>({});

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

  const label = (group: TenantGroup, id: string) =>
    id === "unassigned" ? "" : (stats.names[id] ?? t("deleted", { group }));
  const options = (group: TenantGroup, ids: string[]): PickerItem[] =>
    ids.map((id) =>
      stats.names[id] ? { id, label: stats.names[id] } : { id, label: t("deleted", { group }), detail: id },
    );
  const named = (group: TenantGroup, rows: SliceRow[]) =>
    rows.map((row) => ({ ...row, name: label(group, row.name) }));
  const tenantFilters = [
    {
      key: "model" as const,
      label: t("group.model"),
      options: stats.models.map((id) => ({ id, label: id })),
    },
    { key: "orgId" as const, label: t("group.org"), options: options("org", stats.orgs) },
    { key: "teamId" as const, label: t("group.team"), options: options("team", stats.teams) },
    { key: "projectId" as const, label: t("group.project"), options: options("project", stats.projects) },
    { key: "memberId" as const, label: t("group.member"), options: options("member", stats.members) },
    { key: "keyId" as const, label: t("group.key"), options: options("key", stats.keys) },
    { key: "userId" as const, label: t("group.user"), options: options("user", stats.users) },
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
        {tenantFilters.map((filter) => {
          const kept = picked[filter.key];
          const missing =
            kept && kept.id === query[filter.key] && !filter.options.some((option) => option.id === kept.id);
          return (
            <SearchSelect
              key={filter.key}
              label={filter.label}
              items={[{ id: "all", label: tCommon("all") }, ...filter.options, ...(missing ? [kept] : [])]}
              value={query[filter.key] || "all"}
              onChange={(next) => {
                setPicked((current) => ({
                  ...current,
                  [filter.key]: filter.options.find((option) => option.id === next),
                }));
                apply({ [filter.key]: next === "all" ? "" : next });
              }}
            />
          );
        })}
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
        byTeam={named("team", stats.byTeam)}
        byOrg={named("org", stats.byOrg)}
        byProject={named("project", stats.byProject)}
        byMember={named("member", stats.byMember)}
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
      <Card className="mt-5 gap-4">
        <Card.Header>
          <Card.Title>{t("cache.title")}</Card.Title>
          <Card.Description>{t("cache.description")}</Card.Description>
        </Card.Header>
        {stats.cacheRead || stats.cacheWrite ? (
          <dl aria-busy={pending} className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {(
              [
                ["hitRate", t("columns.hitRate"), format.number(stats.cacheHitRate, "percent")],
                ["cacheRead", t("columns.cacheRead"), format.number(stats.cacheRead, "integer")],
                ["cacheWrite", t("columns.cacheWrite"), format.number(stats.cacheWrite, "integer")],
                ["savings", t("columns.savings"), format.number(stats.cacheSavings, "money")],
              ] as const
            ).map(([key, label, value]) => (
              <div key={key}>
                <dt className="text-xs text-muted">{label}</dt>
                <dd className="text-xl font-semibold tracking-tight">{value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <Card.Description>{t("cache.empty")}</Card.Description>
        )}
      </Card>
      {stats.cacheByProject.length ? (
        <Card className="mt-5 gap-4">
          <Card.Header>
            <Card.Title>{t("cache.byProject")}</Card.Title>
          </Card.Header>
          <Table aria-label={t("cache.byProject")}>
            <Table.ScrollContainer>
              <Table.Content>
                <Table.Header>
                  <Table.Column isRowHeader>{t("group.project")}</Table.Column>
                  <Table.Column>{t("columns.prompt")}</Table.Column>
                  <Table.Column>{t("columns.cacheRead")}</Table.Column>
                  <Table.Column>{t("columns.cacheWrite")}</Table.Column>
                  <Table.Column>{t("columns.hitRate")}</Table.Column>
                  <Table.Column>{t("columns.savings")}</Table.Column>
                </Table.Header>
                <Table.Body>
                  {stats.cacheByProject.map((row) => (
                    <Table.Row key={row.name} id={row.name}>
                      <Table.Cell>{label("project", row.name) || tCommon("none")}</Table.Cell>
                      <Table.Cell>{format.number(row.prompt, "integer")}</Table.Cell>
                      <Table.Cell>{format.number(row.cacheRead ?? 0, "integer")}</Table.Cell>
                      <Table.Cell>{format.number(row.cacheWrite ?? 0, "integer")}</Table.Cell>
                      <Table.Cell>
                        {format.number(row.prompt ? (row.cacheRead ?? 0) / row.prompt : 0, "percent")}
                      </Table.Cell>
                      <Table.Cell>{format.number(row.cacheSavings ?? 0, "money")}</Table.Cell>
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
