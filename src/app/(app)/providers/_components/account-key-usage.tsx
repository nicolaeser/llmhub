"use client";

import { Chip, Skeleton } from "@heroui/react";
import { useFormatter, useTranslations } from "next-intl";
import { LoadError } from "@/components/console/page-status";
import { Link } from "@/i18n/routing";
import type { ProviderView } from "@/types/providers";
import type { AccountRow } from "./account-rows";
import KeyUsageBar, { SegmentDot } from "./key-usage-bar";
import { useKeyName, useSegmentName, useUsagePercent } from "./key-usage-labels";
import { accountUsage, barSegments, keyRanks, keyShade, type KeyRow, type WindowView } from "./key-usage-view";
import { useLimitLabel } from "./limit-meter";
import type { KeyUsageFeed } from "./use-key-usage";
import { useResetTime } from "./use-reset-time";

const FULL_PERCENT = 100;
const WARN_PERCENT = 80;

function usedTone(used: number): string {
  if (used >= FULL_PERCENT) return "text-sm font-medium tabular-nums text-danger";
  if (used >= WARN_PERCENT) return "text-sm font-medium tabular-nums text-warning";
  return "text-sm font-medium tabular-nums text-foreground";
}

export default function AccountKeyUsage({
  row,
  account,
  feed,
  timeZone,
}: {
  row: ProviderView;
  account: AccountRow;
  feed: KeyUsageFeed;
  timeZone: string;
}) {
  const t = useTranslations("Subscriptions.keyUsage");
  const tDetails = useTranslations("Subscriptions.details");
  const tLimits = useTranslations("Subscriptions.limits");
  const format = useFormatter();
  const { now } = useResetTime(timeZone);
  const limitLabel = useLimitLabel();
  const keyName = useKeyName();
  const percent = useUsagePercent();
  const { usage, live } = feed;
  const { data } = usage;
  const segmentName = useSegmentName(data?.keys ?? {});

  const heading = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-semibold">{tDetails("keyUsage")}</h3>
      {data ? (
        <Chip size="sm" variant="soft" color={live ? "success" : undefined} className="whitespace-nowrap">
          {t("freshness", {
            live: String(live),
            when: format.relativeTime(new Date(Math.min(data.at, now.getTime())), now),
          })}
        </Chip>
      ) : null}
    </div>
  );

  if (!data) {
    return (
      <section className="space-y-3" aria-label={tDetails("keyUsage")}>
        {heading}
        <LoadError state={usage} />
        {usage.error === null ? (
          <div className="space-y-2" aria-hidden>
            <Skeleton className="h-3 w-1/2 rounded-lg" />
            <Skeleton className="h-4 w-full rounded-lg" />
            <Skeleton className="h-3 w-2/3 rounded-lg" />
          </div>
        ) : null}
      </section>
    );
  }

  const view = accountUsage(account.groups, data.accounts.find((item) => item.id === row.id), now.getTime());
  const ranks = keyRanks(view);

  const windowBlock = (window: WindowView) => {
    const { group } = window;
    const label = limitLabel(group);
    return (
      <div key={group.id} className="min-w-0 space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 text-sm break-words text-foreground">{label}</span>
          <span className={usedTone(group.usedPercent)}>
            {tLimits("used", { used: group.usedPercent / FULL_PERCENT, uniform: String(group.uniform) })}
          </span>
        </div>
        <KeyUsageBar
          label={label}
          segments={barSegments(window, ranks)}
          used={group.usedPercent}
          nameOf={segmentName}
          freeLabel={t("free")}
        />
        <p className="text-xs text-muted">
          {window.usage
            ? t("windowRequests", { count: window.usage.requests, basis: window.usage.basis })
            : t("windowPending")}
        </p>
      </div>
    );
  };

  const keyItem = (key: KeyRow) => {
    const shade = keyShade(key.rank);
    const name = keyName(key.keyId, data.keys);
    return (
      <li key={key.keyId || "none"} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <span className="flex min-w-0 flex-1 basis-48 items-start gap-2">
          <span className="pt-1.5">
            <SegmentDot kind={shade === null ? "other" : "key"} shade={shade ?? 0.5} />
          </span>
          <span className="min-w-0">
            {key.keyId && data.keys[key.keyId] ? (
              <Link
                href={`/keys/${encodeURIComponent(key.keyId)}`}
                className="block text-sm font-medium break-words text-accent"
              >
                {name.label}
              </Link>
            ) : (
              <span className="block text-sm font-medium break-words text-foreground">{name.label}</span>
            )}
            {name.detail ? <span className="block text-xs break-words text-muted">{name.detail}</span> : null}
          </span>
        </span>
        <dl className="flex flex-wrap gap-x-4 gap-y-1">
          {view.windows.map((window) => {
            const slice = key.byWindow[window.group.id];
            return (
              <div key={window.group.id} className="min-w-0 text-right">
                <dt className="text-xs text-muted">{limitLabel(window.group)}</dt>
                <dd className="text-sm font-medium tabular-nums text-foreground">{percent(slice?.percent ?? 0)}</dd>
              </div>
            );
          })}
        </dl>
      </li>
    );
  };

  return (
    <section className="space-y-4" aria-label={tDetails("keyUsage")}>
      <div className="space-y-1">
        {heading}
        <p className="text-xs text-muted">{tDetails("keyUsageHint")}</p>
      </div>
      <LoadError state={usage} />
      {view.windows.length ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{view.windows.map(windowBlock)}</div>
      ) : null}
      {view.keys.length === 0 ? (
        <p className="text-sm text-muted">{t("noRequests")}</p>
      ) : (
        <ul aria-label={t("keysOn", { account: account.title })} className="space-y-3">
          {view.keys.map(keyItem)}
        </ul>
      )}
    </section>
  );
}
