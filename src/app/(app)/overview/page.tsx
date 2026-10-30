"use client";

import { Activity, CircleDollarSign, KeyRound, LayoutDashboard, OctagonAlert, Plug } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import PageHeader from "@/components/console/page-header";
import PageStatus, { LoadError } from "@/components/console/page-status";
import StatCard from "@/components/console/stat-card";
import { useActionData } from "@/lib/hooks/use-action-data";
import type { Tone } from "@/types/console";
import type { LucideIcon } from "lucide-react";
import { loadOverviewAction } from "./_action";
import AttentionList from "./_components/attention-list";
import ConceptCards from "./_components/concept-cards";
import SetupChecklist from "./_components/setup-checklist";

type Stat = { id: string; label: string; value: string; hint?: string; icon: LucideIcon; tone: Tone };

export default function OverviewPage() {
  const t = useTranslations("Overview");
  const format = useFormatter();
  const state = useActionData(loadOverviewAction);
  const data = state.data;

  if (!data) {
    return (
      <PageStatus
        icon={LayoutDashboard}
        title={t("title")}
        subtitle={t("subtitle")}
        state={state}
        stats={4}
        layout="dashboard"
      />
    );
  }

  const stats: Stat[] = [];
  if (data.today && data.week) {
    stats.push(
      {
        id: "spend",
        label: t("stats.spendToday"),
        value: format.number(data.today.spend, "money"),
        hint: t("stats.weekSpend", { amount: data.week.spend }),
        icon: CircleDollarSign,
        tone: "accent",
      },
      {
        id: "requests",
        label: t("stats.requestsToday"),
        value: format.number(data.today.requests, "integer"),
        hint: t("stats.weekRequests", { count: data.week.requests }),
        icon: Activity,
        tone: data.today.requests > 0 ? "success" : "neutral",
      },
    );
  }
  if (data.keys) {
    stats.push({
      id: "keys",
      label: t("stats.activeKeys"),
      value: format.number(data.keys.active, "integer"),
      hint: t("stats.keysTotal", { count: data.keys.total }),
      icon: KeyRound,
      tone: data.keys.active > 0 ? "accent" : "neutral",
    });
  }
  if (data.providers) {
    stats.push({
      id: "providers",
      label: t("stats.providersOnline"),
      value: format.number(data.providers.online, "integer"),
      hint: t("stats.providersTotal", { count: data.providers.total }),
      icon: Plug,
      tone: data.providers.total === 0 ? "neutral" : data.providers.online < data.providers.total ? "warning" : "success",
    });
  } else if (data.today) {
    stats.push({
      id: "errors",
      label: t("stats.errorsToday"),
      value: format.number(data.today.errors, "integer"),
      icon: OctagonAlert,
      tone: data.today.errors > 0 ? "danger" : "neutral",
    });
  }

  return (
    <div>
      <PageHeader icon={LayoutDashboard} title={t("title")} subtitle={t("subtitle")} />
      <div className="space-y-5">
        <LoadError state={state} />
        {stats.length ? (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {stats.map((stat) => (
                <StatCard
                  key={stat.id}
                  label={stat.label}
                  value={stat.value}
                  hint={stat.hint}
                  icon={stat.icon}
                  tone={stat.tone}
                />
              ))}
            </div>
            {data.today ? <p className="text-xs text-muted">{t("stats.utc")}</p> : null}
          </div>
        ) : null}
        <div className="grid items-start gap-5 xl:grid-cols-5">
          {data.steps.length ? (
            <div className="min-w-0 xl:col-span-3">
              <SetupChecklist steps={data.steps} />
            </div>
          ) : null}
          <div className={data.steps.length ? "min-w-0 xl:col-span-2" : "min-w-0 xl:col-span-5"}>
            <AttentionList items={data.attention} />
          </div>
        </div>
        <ConceptCards concepts={data.concepts} />
      </div>
    </div>
  );
}
