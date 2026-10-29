"use client";

import { useEffect, useRef, useState } from "react";
import { Chip, SearchField } from "@heroui/react";
import { Activity, Gauge, KeyRound, UserRound } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import EmptyState from "@/components/console/empty-state";
import PageStatus, { LoadError } from "@/components/console/page-status";
import StatCard from "@/components/console/stat-card";
import { reportsLimits } from "@/lib/gateway/upstreams/provider-kinds";
import { useActionData } from "@/lib/hooks/use-action-data";
import { useConsoleTimeZone } from "@/lib/hooks/use-console-time-zone";
import { useLiveConnected, useLiveRequests } from "@/lib/hooks/use-live";
import { isActionFail } from "@/lib/http/action-result";
import { meterColor } from "@/lib/utils/budget";
import type { ProviderView, SubscriptionKeyUsage } from "@/types/providers";
import { loadSubscriptionKeyUsageAction } from "../_action";
import { accountMatches, accountRow } from "./account-rows";
import KeyUsageAccount, { useKeyName } from "./key-usage-account";
import { accountUsage } from "./key-usage-view";
import { useLimitLabel } from "./limit-meter";
import type { AccountLimitsState } from "./use-account-limits";
import { useResetTime } from "./use-reset-time";

const REFRESH_GAP_MS = 10_000;
const FALLBACK_POLL_MS = 30_000;
const FULL_PERCENT = 100;

function maxBy<T>(items: T[], value: (item: T) => number): T | null {
  return items.reduce<T | null>((top, item) => (top === null || value(item) > value(top) ? item : top), null);
}

function useLiveKeyUsage(trigger: string) {
  const usage = useActionData<SubscriptionKeyUsage>(loadSubscriptionKeyUsageAction);
  const { setData } = usage;
  const live = useLiveConnected();
  const seen = useRef(trigger);
  const lastRun = useRef(0);
  const ticket = useRef(0);

  useEffect(() => {
    if (seen.current === trigger) return;
    seen.current = trigger;
    const wait = Math.max(0, lastRun.current + REFRESH_GAP_MS - Date.now());
    const timer = setTimeout(() => {
      lastRun.current = Date.now();
      const current = ++ticket.current;
      loadSubscriptionKeyUsageAction().then((res) => {
        if (current === ticket.current && !isActionFail(res)) setData(res);
      });
    }, wait);
    return () => clearTimeout(timer);
  }, [trigger, setData]);

  useEffect(() => {
    if (live) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const current = ++ticket.current;
      loadSubscriptionKeyUsageAction().then((res) => {
        if (current === ticket.current && !isActionFail(res)) setData(res);
      });
    }, FALLBACK_POLL_MS);
    return () => clearInterval(timer);
  }, [live, setData]);

  return { usage, live };
}

export default function KeyUsageTab({ rows, limits }: { rows: ProviderView[]; limits: AccountLimitsState }) {
  const t = useTranslations("Subscriptions.keyUsage");
  const tCommon = useTranslations("Common");
  const tProviders = useTranslations("Providers");
  const format = useFormatter();
  const timeZone = useConsoleTimeZone();
  const { now } = useResetTime(timeZone);
  const limitLabel = useLimitLabel();
  const keyName = useKeyName();
  const [query, setQuery] = useState("");
  const { items } = limits;
  const tracked = rows.filter((row) => reportsLimits(row.kind));
  const versions = tracked.map((row) => `${row.id}:${items[row.id]?.version ?? 0}`).join(",");
  const requestId = useLiveRequests()?.requestId ?? "";
  const { usage, live } = useLiveKeyUsage(`${requestId}|${versions}`);
  const { data } = usage;

  if (!data || limits.checking) return <PageStatus state={usage} stats={4} layout="cards" />;

  const byAccount = new Map(data.accounts.map((account) => [account.id, account]));
  const nowMs = now.getTime();
  const views = tracked
    .map((row) => {
      const account = accountRow(row, items[row.id], true, nowMs);
      return { row, account, usage: accountUsage(account.groups, byAccount.get(row.id), nowMs) };
    })
    .filter((view) => view.account.groups.length > 0)
    .sort(
      (a, b) =>
        b.usage.peak - a.usage.peak ||
        b.usage.requests - a.usage.requests ||
        a.account.title.localeCompare(b.account.title),
    );

  if (views.length === 0) {
    return <EmptyState icon={Gauge} title={t("emptyTitle")} description={t("empty")} />;
  }

  const fullest = maxBy(
    views.flatMap((view) => view.usage.windows.map((window) => ({ view, group: window.group }))),
    (item) => item.group.usedPercent,
  );
  const topSlice = maxBy(
    views.flatMap((view) =>
      view.usage.windows.flatMap((window) => window.slices.map((slice) => ({ view, group: window.group, slice }))),
    ),
    (item) => item.slice.percent,
  );
  const activeKeys = new Set(views.flatMap((view) => view.usage.keys.map((key) => key.keyId))).size;
  const inUse = views.filter((view) => view.usage.requests > 0).length;
  const percent = (value: number) =>
    format.number(value / FULL_PERCENT, { style: "percent", maximumFractionDigits: value < 10 ? 1 : 0 });

  const needle = query.trim().toLocaleLowerCase();
  const shown = views.filter(
    (view) =>
      accountMatches(view.row, query, [tProviders("kindName", { kind: view.row.kind }), view.account.plan]) ||
      view.usage.keys.some((key) => {
        const name = keyName(key.keyId, data.keys);
        return [name.label, name.detail].some((value) => value.toLocaleLowerCase().includes(needle));
      }),
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4">
        <p className="max-w-3xl text-sm text-muted">{t("intro")}</p>
        <div className="flex flex-wrap items-center gap-3">
          <SearchField value={query} onChange={setQuery} aria-label={t("search")} className="w-full max-w-sm">
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input placeholder={t("search")} />
              <SearchField.ClearButton aria-label={tCommon("close")} />
            </SearchField.Group>
          </SearchField>
          <Chip size="sm" variant="soft" color={live ? "success" : undefined} className="whitespace-nowrap">
            {t("freshness", {
              live: String(live),
              when: format.relativeTime(new Date(Math.min(data.at, nowMs)), now),
            })}
          </Chip>
        </div>
      </div>

      <LoadError state={usage} />

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard
          icon={Gauge}
          tone={fullest ? meterColor(fullest.group.usedPercent / FULL_PERCENT) : "neutral"}
          label={t("stats.fullest")}
          value={fullest ? percent(fullest.group.usedPercent) : tCommon("none")}
          hint={
            fullest
              ? t("stats.where", { window: limitLabel(fullest.group), account: fullest.view.account.title })
              : undefined
          }
        />
        <StatCard
          icon={KeyRound}
          tone={topSlice ? "accent" : "neutral"}
          label={t("stats.topKey")}
          value={topSlice ? keyName(topSlice.slice.keyId, data.keys).label : tCommon("none")}
          hint={
            topSlice
              ? t("stats.topKeyHint", {
                  used: percent(topSlice.slice.percent),
                  window: limitLabel(topSlice.group),
                  account: topSlice.view.account.title,
                })
              : undefined
          }
        />
        <StatCard
          icon={Activity}
          tone={activeKeys > 0 ? "accent" : "neutral"}
          label={t("stats.activeKeys")}
          value={format.number(activeKeys)}
          hint={t("stats.activeKeysHint")}
        />
        <StatCard
          icon={UserRound}
          tone={inUse > 0 ? "success" : "neutral"}
          label={t("stats.inUse")}
          value={t("stats.inUseValue", { used: inUse, total: views.length })}
          hint={t("stats.inUseHint")}
        />
      </div>

      {shown.length === 0 ? <EmptyState icon={Gauge} title={t("noMatches")} /> : null}

      <div className="space-y-5">
        {shown.map((view) => (
          <KeyUsageAccount
            key={view.row.id}
            row={view.row}
            account={view.account}
            usage={view.usage}
            keys={data.keys}
            timeZone={timeZone}
          />
        ))}
      </div>
    </div>
  );
}
