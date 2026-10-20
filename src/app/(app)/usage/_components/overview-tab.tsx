"use client";

import { useState } from "react";
import {
  Button,
  buttonVariants,
  Card,
  Chip,
  Disclosure,
  Label,
  ListBox,
  Select,
  Table,
} from "@heroui/react";
import {
  Activity,
  AlertTriangle,
  Ban,
  CircleDollarSign,
  Coins,
  Download,
  Gauge,
  SlidersHorizontal,
  Timer,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { loadUsageAction, loadUsageTodayAction } from "../_action";
import { useActionData } from "@/lib/hooks/use-action-data";
import { useLiveConnected, useLiveUsageToday } from "@/lib/hooks/use-live";
import { BELOW_MD, useMediaQuery } from "@/lib/hooks/use-media-query";
import PageStatus, { LoadError, SectionLoading } from "@/components/console/page-status";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import SearchSelect from "@/components/console/search-select";
import StatCard from "@/components/console/stat-card";
import MarginCard from "./margin-card";
import UsageCharts from "./usage-charts";
import type { PickerItem } from "@/types/console";
import type { UsageQuery, SliceRow } from "@/types/usage";

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

export default function OverviewTab() {
  const t = useTranslations("Usage");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const [query, setQuery] = useState<UsageQuery>(INITIAL_QUERY);
  const [picked, setPicked] = useState<Partial<Record<FilterKey, PickerItem>>>({});
  const [filtersOpen, setFiltersOpen] = useState(false);
  const compact = useMediaQuery(BELOW_MD);
  const usage = useActionData(() => loadUsageAction(INITIAL_QUERY));
  const { data: stats, pending } = usage;
  const todaySeed = useActionData(loadUsageTodayAction);
  const today = useLiveUsageToday(todaySeed.data);
  const live = useLiveConnected();

  function apply(patch: Partial<UsageQuery>) {
    const next = { ...query, ...patch };
    setQuery(next);
    usage.reloadWith(() => loadUsageAction(next));
  }

  if (!stats) {
    return <PageStatus state={usage} layout="charts" />;
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
    ...(stats.companyView ? [] : [{ key: "orgId" as const, label: t("group.org"), options: options("org", stats.orgs) }]),
    { key: "teamId" as const, label: t("group.team"), options: options("team", stats.teams) },
    { key: "projectId" as const, label: t("group.project"), options: options("project", stats.projects) },
    { key: "memberId" as const, label: t("group.member"), options: options("member", stats.members) },
    { key: "keyId" as const, label: t("group.key"), options: options("key", stats.keys) },
    { key: "userId" as const, label: t("group.user"), options: options("user", stats.users) },
  ];

  const tenantFields = tenantFilters.map((filter) => {
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
  });
  const activeFilters = tenantFilters.filter((filter) => query[filter.key]).length;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-end gap-2">
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
        {compact ? null : tenantFields}
      </div>
      {compact && tenantFields.length ? (
        <Card className="mb-5">
          <Disclosure isExpanded={filtersOpen} onExpandedChange={setFiltersOpen}>
            <Disclosure.Heading>
              <Disclosure.Trigger className="flex w-full items-center justify-between gap-2 text-sm font-medium">
                <span className="flex items-center gap-2">
                  <SlidersHorizontal size={14} aria-hidden />
                  {t("filters", { count: activeFilters })}
                </span>
                <Disclosure.Indicator />
              </Disclosure.Trigger>
            </Disclosure.Heading>
            <Disclosure.Content>
              <Disclosure.Body className="grid gap-3 pt-4">{tenantFields}</Disclosure.Body>
            </Disclosure.Content>
          </Disclosure>
        </Card>
      ) : null}
      <LoadError state={usage} className="mb-5" />
      {today && activeFilters === 0 ? (
        <Card className="mb-5 gap-4">
          <Card.Header className="flex-row flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1 basis-64">
              <Card.Title>{t("today.title")}</Card.Title>
              <Card.Description>
                {t("today.description", {
                  day: format.dateTime(new Date(`${today.day}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" }),
                })}
              </Card.Description>
            </div>
            {live ? (
              <Chip size="sm" variant="soft" color="success">
                {t("today.live")}
              </Chip>
            ) : null}
          </Card.Header>
          <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {(
              [
                ["spend", t("metrics.spend"), format.number(today.spend, "money")],
                ["requests", t("metrics.requests"), format.number(today.requests, "integer")],
                ["errors", t("metrics.errors"), format.number(today.errors, "integer")],
                ["tokens", t("metrics.tokens"), format.number(today.tokens, "integer")],
              ] as const
            ).map(([key, label, value]) => (
              <div key={key}>
                <dt className="text-xs text-muted">{label}</dt>
                <dd className="text-xl font-semibold tracking-tight">{value}</dd>
              </div>
            ))}
          </dl>
        </Card>
      ) : null}
      <p className="sr-only">
        {t("summary", {
          spend: stats.spend,
          count: stats.count,
          errors: stats.errors,
        })}
      </p>
      <div aria-busy={pending} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon={CircleDollarSign} label={t("metrics.spend")} value={pending ? null : format.number(stats.spend, "money")} />
        <StatCard icon={Coins} label={t("metrics.tokens")} value={pending ? null : format.number(stats.tokens, "integer")} />
        <StatCard
          icon={Activity}
          tone="success"
          label={t("metrics.requests")}
          value={pending ? null : format.number(stats.count, "integer")}
        />
        <StatCard
          icon={AlertTriangle}
          tone={stats.errors > 0 ? "danger" : "neutral"}
          label={t("metrics.errors")}
          value={pending ? null : format.number(stats.errors, "integer")}
        />
      </div>
      <div aria-busy={pending} className="mt-3 grid gap-3 sm:grid-cols-3">
        <StatCard
          icon={Timer}
          tone="neutral"
          label={t("metrics.latency")}
          value={pending ? null : t("latencyValue", { ms: Math.round(stats.latency) })}
        />
        <StatCard
          icon={Gauge}
          tone="neutral"
          label={t("metrics.p95")}
          value={pending ? null : t("latencyValue", { ms: Math.round(stats.p95Latency) })}
        />
        <StatCard
          icon={Ban}
          tone={stats.rate429 > 0 ? "warning" : "neutral"}
          label={t("metrics.rate429")}
          value={pending ? null : format.number(stats.rate429, "integer")}
        />
      </div>
      {pending ? (
        <div className="mt-5">
          <SectionLoading shape="charts" />
        </div>
      ) : (
        <>
        {stats.purchase === null ? null : (
          <MarginCard
            companyView={stats.companyView}
            chargeback={stats.chargeback}
            names={stats.names}
            purchase={stats.purchase}
            sale={stats.spend}
          />
        )}
        <UsageCharts
          daily={stats.daily}
          byModel={stats.byModel}
          byTeam={named("team", stats.byTeam)}
          byOrg={stats.companyView ? [] : named("org", stats.byOrg)}
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
            <RowCards label={t("pdf.byModel")}>
              {stats.byModel.map((row) => (
                <RowCard
                  key={row.name || "none"}
                  variant="secondary"
                  title={row.name || tCommon("none")}
                  details={[
                    { label: t("columns.spend"), value: format.number(row.spend, "money"), wide: true },
                    { label: t("columns.prompt"), value: format.number(row.prompt, "integer") },
                    { label: t("columns.completion"), value: format.number(row.completion, "integer") },
                  ]}
                />
              ))}
            </RowCards>
            <Table aria-label={t("pdf.byModel")} className={TABLE_FROM_LG}>
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
            <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
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
            <RowCards label={t("cache.byProject")}>
              {stats.cacheByProject.map((row) => (
                <RowCard
                  key={row.name}
                  variant="secondary"
                  title={label("project", row.name) || tCommon("none")}
                  details={[
                    { label: t("columns.prompt"), value: format.number(row.prompt, "integer") },
                    {
                      label: t("columns.hitRate"),
                      value: format.number(row.prompt ? (row.cacheRead ?? 0) / row.prompt : 0, "percent"),
                    },
                    { label: t("columns.cacheRead"), value: format.number(row.cacheRead ?? 0, "integer") },
                    { label: t("columns.cacheWrite"), value: format.number(row.cacheWrite ?? 0, "integer") },
                    { label: t("columns.savings"), value: format.number(row.cacheSavings ?? 0, "money") },
                  ]}
                />
              ))}
            </RowCards>
            <Table aria-label={t("cache.byProject")} className={TABLE_FROM_LG}>
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
        </>
      )}
    </div>
  );
}
