"use client";

import { Button, Chip } from "@heroui/react";
import { Activity, AlertTriangle, Blocks, CircleDollarSign, Clock, ScrollText } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import StatCard from "@/components/console/stat-card";
import { AccessSummaryCard } from "@/components/keys/key-fields";
import { Link } from "@/i18n/routing";
import { logsHref } from "@/lib/gateway/request-logs/request-log-query";
import { usageHref } from "@/lib/usage/usage-query";
import type { KeyDetailPage, KeySection } from "@/types/keys";
import KeyBudgetCard from "./key-budget-card";
import SectionCard, { Facts } from "./section-card";

const WHOLE_DAY = "00:00";

type TabProps = {
  data: KeyDetailPage;
  now: Date;
  onEdit?: (section: KeySection) => void;
};

function editor(onEdit: TabProps["onEdit"], canManage: boolean, section: KeySection) {
  return canManage && onEdit ? () => onEdit(section) : undefined;
}

export function OverviewTab({ data, now, onEdit }: TabProps) {
  const t = useTranslations("Keys.detail");
  const tKeys = useTranslations("Keys");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const { key, owner, activity } = data;
  const place = tKeys("binding.place", {
    org: owner.orgAlias,
    team: owner.teamAlias,
    hasTeam: owner.teamAlias ? "yes" : "no",
  });
  const expires = key.expires ? new Date(key.expires) : null;
  const lastUsed = activity?.lastUsed ? new Date(activity.lastUsed) : null;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          icon={CircleDollarSign}
          label={t("spendPeriod")}
          value={format.number(key.spend, "money")}
          tone={key.max_budget > 0 && key.spend >= key.max_budget ? "danger" : "accent"}
          hint={
            key.max_budget > 0
              ? t("spendOf", { cap: key.max_budget })
              : t("noOwnLimit")
          }
        />
        {activity ? (
          <>
            <StatCard
              icon={Activity}
              tone={activity.requests7d > 0 ? "success" : "neutral"}
              label={tKeys("overview.requests")}
              value={format.number(activity.requests7d, "integer")}
              hint={t("spend7d", { spend: activity.spend7d })}
            />
            <StatCard
              icon={AlertTriangle}
              tone={activity.errors7d > 0 ? "danger" : "neutral"}
              label={tKeys("overview.errors")}
              value={format.number(activity.errors7d, "integer")}
            />
            <StatCard
              icon={Clock}
              tone="neutral"
              label={t("lastUsed")}
              value={lastUsed ? format.relativeTime(lastUsed, now) : t("neverUsed")}
            />
          </>
        ) : null}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <SectionCard
          title={t("ownerTitle")}
          description={tKeys("binding.hint", { kind: owner.kind, scope: data.options.companyId ? "company" : "platform" })}
          editLabel={t("editSection", { section: "basics" })}
          onEdit={editor(onEdit, data.canManage, "basics")}
        >
          <Facts
            items={[
              { label: tKeys("binding.kind", { kind: owner.kind }), value: owner.name || tCommon("none") },
              {
                label: t("company"),
                value: owner.orgAlias ? (
                  data.canOpenCompany ? (
                    <Link href={`/companies/${owner.orgId}`} className="text-accent">
                      {place}
                    </Link>
                  ) : (
                    place
                  )
                ) : (
                  t("platform")
                ),
              },
            ]}
          />
        </SectionCard>
        <SectionCard title={t("detailsTitle")} description={t("detailsHint")}>
          <Facts
            items={[
              { label: t("prefix"), value: <span className="font-mono">{key.key_name}…</span> },
              { label: t("created"), value: format.dateTime(new Date(key.created_at), "stamp") },
              {
                label: t("expires"),
                value: expires ? (
                  <span className={expires <= now ? "text-danger" : undefined}>{format.dateTime(expires, "stamp")}</span>
                ) : (
                  t("never")
                ),
              },
              { label: t("keyId"), value: <span className="font-mono text-xs break-all">{key.token_id}</span> },
            ]}
          />
        </SectionCard>
      </div>

      {data.canSeeUsage ? (
        <SectionCard title={t("activityTitle")} description={t("activityHint")}>
          <div className="flex flex-wrap gap-2">
            <Link href={usageHref({ keyId: key.token_id })} className="inline-flex items-center gap-1.5 text-sm font-medium text-accent">
              <Activity size={14} aria-hidden />
              {t("openUsage")}
            </Link>
            <span className="text-muted" aria-hidden>
              ·
            </span>
            <Link href={logsHref({ keyId: key.token_id })} className="inline-flex items-center gap-1.5 text-sm font-medium text-accent">
              <ScrollText size={14} aria-hidden />
              {t("openLogs")}
            </Link>
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}

export function AccessTab({ data, onEdit }: TabProps) {
  const t = useTranslations("Keys.detail");
  const tKeys = useTranslations("Keys");
  const tTemplates = useTranslations("ModelTemplates");
  const { key, options } = data;
  const presets = options.templates.filter((template) => key.templates.includes(template.id));
  const restricted = key.models.length > 0 || key.templates.length > 0;

  return (
    <div className="space-y-5">
      <SectionCard
        title={t("accessTitle")}
        description={t("accessHint", { restricted: restricted ? "yes" : "no" })}
        editLabel={t("editSection", { section: "access" })}
        onEdit={editor(onEdit, data.canManage, "access")}
      >
        <div className="space-y-4">
          {restricted ? (
            <Facts
              items={[
                {
                  label: tKeys("fields.templates"),
                  value: presets.length ? (
                    <span className="flex flex-wrap gap-1">
                      {presets.map((preset) => (
                        <Chip key={preset.id} size="sm" variant="soft">
                          {preset.name} · {tTemplates("matchCount", { count: preset.matches.length })}
                        </Chip>
                      ))}
                    </span>
                  ) : (
                    t("none")
                  ),
                  wide: true,
                },
                {
                  label: tKeys("fields.models"),
                  value: key.models.length ? (
                    <span className="flex flex-wrap gap-1">
                      {key.models.map((model) => (
                        <Chip key={model} size="sm" variant="soft">
                          <span className="break-all">{model}</span>
                        </Chip>
                      ))}
                    </span>
                  ) : (
                    t("none")
                  ),
                  wide: true,
                },
              ]}
            />
          ) : null}
          <AccessSummaryCard draft={{ restricted, models: key.models, templateIds: key.templates }} options={options} />
        </div>
      </SectionCard>
    </div>
  );
}

export function LimitsTab({
  data,
  now,
  onEdit,
  onBudget,
  onBoost,
}: TabProps & { onBudget: () => void; onBoost: () => void }) {
  const t = useTranslations("Keys.detail");
  const tKeys = useTranslations("Keys");
  const format = useFormatter();
  const { key } = data;
  const expires = key.expires ? new Date(key.expires) : null;

  return (
    <div className="space-y-5">
      <KeyBudgetCard
        budget={data.budget?.budget ?? { maxBudget: key.max_budget, spend: key.spend, budgetDuration: key.budget_duration }}
        now={now}
        canBudget={data.canBudget}
        onBudget={onBudget}
        onBoost={onBoost}
      />
      <SectionCard
        title={t("rateTitle")}
        description={t("rateHint")}
        editLabel={t("editSection", { section: "limits" })}
        onEdit={editor(onEdit, data.canManage, "limits")}
      >
        <Facts
          items={[
            { label: tKeys("fields.rpm"), value: key.rpm_limit > 0 ? format.number(key.rpm_limit, "integer") : t("unlimited") },
            { label: tKeys("fields.tpm"), value: key.tpm_limit > 0 ? format.number(key.tpm_limit, "integer") : t("unlimited") },
            {
              label: tKeys("fields.maxRequestCost"),
              value: key.max_request_cost > 0 ? format.number(key.max_request_cost, "price") : t("unlimited"),
            },
          ]}
        />
      </SectionCard>
      <SectionCard title={t("expiryTitle")} description={t("expiryHint", { expires: expires ? "yes" : "no" })}>
        <Facts
          items={[
            {
              label: t("expires"),
              value: expires ? (
                <span className={expires <= now ? "text-danger" : undefined}>{format.dateTime(expires, "stamp")}</span>
              ) : (
                t("never")
              ),
            },
            { label: t("created"), value: format.dateTime(new Date(key.created_at), "stamp") },
          ]}
        />
      </SectionCard>
    </div>
  );
}

export function SecurityTab({ data, onEdit }: TabProps) {
  const t = useTranslations("Keys.detail");
  const tKeys = useTranslations("Keys");
  const format = useFormatter();
  const { key } = data;

  return (
    <div className="space-y-5">
      <SectionCard
        title={t("networkTitle")}
        description={t("networkHint")}
        editLabel={t("editSection", { section: "network" })}
        onEdit={editor(onEdit, data.canManage, "network")}
      >
        <Facts
          items={[
            {
              label: tKeys("fields.allowedIps"),
              value: key.allowed_ips.length ? (
                <span className="font-mono text-xs">{format.list(key.allowed_ips, { type: "unit" })}</span>
              ) : (
                t("anyIp")
              ),
            },
            {
              label: tKeys("fields.endpoints"),
              value: key.allowed_endpoints.length
                ? format.list(
                    key.allowed_endpoints.map((endpoint) => tKeys("endpoints.name", { endpoint })),
                    { type: "conjunction" },
                  )
                : t("allEndpoints"),
            },
          ]}
        />
      </SectionCard>
      <SectionCard
        title={tKeys("windows.title")}
        description={tKeys("windows.hint")}
        editLabel={t("editSection", { section: "schedule" })}
        onEdit={editor(onEdit, data.canManage, "schedule")}
      >
        {key.access_windows.length ? (
          <div className="space-y-2">
            <ul className="space-y-1">
              {key.access_windows.map((window, index) => (
                <li key={index} className="text-sm text-foreground">
                  {t("window", {
                    days: format.list(
                      window.days.map((day) => tKeys("windows.dayShort", { day })),
                      { type: "unit" },
                    ),
                    allDay: window.start === WHOLE_DAY && window.end === WHOLE_DAY ? "yes" : "no",
                    start: window.start,
                    end: window.end,
                  })}
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted">{t("timeZone", { zone: key.access_time_zone })}</p>
          </div>
        ) : (
          <p className="text-sm text-muted">{t("anyTime")}</p>
        )}
      </SectionCard>
      <SectionCard
        title={t("contentTitle")}
        description={tKeys("fields.logContentHint")}
        editLabel={t("editSection", { section: "content" })}
        onEdit={editor(onEdit, data.canManage, "content")}
      >
        <Chip size="sm" variant="soft" color={key.log_content ? "success" : "warning"}>
          {t("contentState", { logged: key.log_content ? "yes" : "no" })}
        </Chip>
      </SectionCard>
    </div>
  );
}

export function IntegrationsTab({ onMcp }: { onMcp: () => void }) {
  const t = useTranslations("Keys.detail");
  const tKeys = useTranslations("Keys");
  return (
    <SectionCard
      title={t("mcpTitle")}
      description={t("mcpHint")}
      action={
        <Button size="sm" variant="secondary" onPress={onMcp}>
          <Blocks size={14} aria-hidden />
          {tKeys("mcp.action")}
        </Button>
      }
    />
  );
}
