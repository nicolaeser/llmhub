"use client";

import { Button, Card, Chip, Disclosure, Skeleton, Spinner } from "@heroui/react";
import { RefreshCw, Users } from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import SubscriptionBadge, { PlanBadge } from "@/components/console/subscription-badge";
import PolicyChips from "./policy-chips";
import ProviderActions from "./provider-actions";
import ProviderToggle from "./provider-toggle";
import type { AccountLimits, LimitWindow, ProviderView } from "@/types/providers";
import { ACCOUNT_STATE_COLOR, accountState, recoveryAt } from "./account-status";
import LimitMeter from "./limit-meter";

function byLength(a: LimitWindow, b: LimitWindow): number {
  return a.windowSeconds - b.windowSeconds;
}

export default function AccountCard({
  row,
  reports,
  entry,
  timeZone,
  refreshing,
  onRefresh,
  onEdit,
  onImport,
  onAccess,
  onDeleted,
  onToggled,
}: {
  row: ProviderView;
  reports: boolean;
  entry: AccountLimits | undefined;
  timeZone: string;
  refreshing: boolean;
  onRefresh: (id: string) => void;
  onEdit: (row: ProviderView) => void;
  onImport: (row: ProviderView) => void;
  onAccess: (row: ProviderView) => void;
  onDeleted: (id: string) => void;
  onToggled: (provider: ProviderView) => void;
}) {
  const t = useTranslations("Subscriptions");
  const tProviders = useTranslations("Providers");
  const tError = useTranslations("Error");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const state = accountState(row, entry, reports);
  const limits = entry?.limits ?? null;
  const planWindows = limits ? limits.windows.filter((window) => !window.scope).sort(byLength) : [];
  const scopedWindows = limits ? limits.windows.filter((window) => window.scope).sort(byLength) : [];
  const recovery = state === "limited" ? recoveryAt(entry) : null;
  const plan = limits?.plan || row.signIn?.plan || "";

  return (
    <Card variant="secondary">
      <Card.Header>
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1 basis-40">
            <Card.Title className="truncate">{row.name}</Card.Title>
            <Card.Description className="truncate">
              {tProviders("signIn.account", {
                named: row.signIn?.account ? "true" : "false",
                account: row.signIn?.account ?? "",
              })}
            </Card.Description>
          </div>
          <div className="flex min-w-0 max-w-full flex-wrap justify-end gap-1">
            <SubscriptionBadge />
            <PlanBadge plan={plan} />
            <Chip size="sm" variant="soft" color={ACCOUNT_STATE_COLOR[state]} className="whitespace-nowrap">
              {t("status", { status: state })}
            </Chip>
          </div>
        </div>
      </Card.Header>
      <Card.Content className="space-y-4">
        <PolicyChips policy={row.policy} />
        {state === "paused" ? <p className="text-sm text-muted">{t("pausedHint")}</p> : null}
        {state === "limited" ? (
          <p className="text-sm text-warning">
            {recovery
              ? t("backIn", {
                  when: format.relativeTime(new Date(recovery), now),
                  date: format.dateTime(new Date(recovery), {
                    weekday: "short",
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                    timeZone,
                    timeZoneName: "short",
                  }),
                })
              : t("backInUnknown")}
          </p>
        ) : null}
        {state === "expired" ? <p className="text-sm text-danger">{t("expiredHint")}</p> : null}
        {!reports && state !== "expired" ? <p className="text-sm text-muted">{t("noLimits")}</p> : null}
        {reports && state === "checking" ? (
          <div className="space-y-3" aria-hidden>
            <Skeleton className="h-3 w-1/3 rounded-lg" />
            <Skeleton className="h-2 w-full rounded-lg" />
            <Skeleton className="h-3 w-1/3 rounded-lg" />
            <Skeleton className="h-2 w-full rounded-lg" />
          </div>
        ) : null}
        {entry?.error && entry.error !== "SIGN_IN_EXPIRED" ? (
          <p className="text-sm text-warning">{tError("code", { code: entry.error })}</p>
        ) : null}
        {limits && limits.windows.length === 0 ? <p className="text-sm text-muted">{t("limits.none")}</p> : null}
        {planWindows.length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {planWindows.map((window, index) => (
              <LimitMeter key={`plan-${window.windowSeconds}-${index}`} window={window} timeZone={timeZone} />
            ))}
          </div>
        ) : null}
        {scopedWindows.length > 0 ? (
          <Disclosure>
            <Disclosure.Heading>
              <Disclosure.Trigger className="flex w-full items-center justify-between text-sm text-muted">
                {t("limits.modelLimits", { count: scopedWindows.length })}
                <Disclosure.Indicator />
              </Disclosure.Trigger>
            </Disclosure.Heading>
            <Disclosure.Content>
              <Disclosure.Body className="grid gap-4 pt-3 sm:grid-cols-2">
                {scopedWindows.map((window, index) => (
                  <LimitMeter key={`${window.scope}-${index}`} window={window} scoped timeZone={timeZone} />
                ))}
              </Disclosure.Body>
            </Disclosure.Content>
          </Disclosure>
        ) : null}
        {limits?.resetCredits || limits?.extraUsage || limits?.credits ? (
          <ul className="space-y-1 text-sm text-muted">
            {limits.resetCredits ? <li>{t("limits.resetCredits", limits.resetCredits)}</li> : null}
            {limits.extraUsage ? (
              <li>
                {t("limits.extraUsage", {
                  used: format.number(limits.extraUsage.usedCents / 100, { style: "currency", currency: "USD" }),
                  limit: format.number(limits.extraUsage.limitCents / 100, { style: "currency", currency: "USD" }),
                })}
              </li>
            ) : null}
            {limits.credits ? (
              <li>
                {t("limits.credits", {
                  unlimited: limits.credits.unlimited ? "true" : "false",
                  balance: limits.credits.balance,
                })}
              </li>
            ) : null}
          </ul>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className={row.restricted ? "text-sm text-warning" : "text-sm text-muted"}>
            {t("access.summary", { restricted: String(row.restricted), count: row.assignments.length })}
          </p>
          <Button size="sm" variant="tertiary" aria-label={t("access.manage")} onPress={() => onAccess(row)}>
            <Users size={14} aria-hidden />
            {t("access.manage")}
          </Button>
        </div>
      </Card.Content>
      <Card.Footer className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <ProviderToggle row={row} onChanged={onToggled} />
          {reports && state !== "expired" ? (
            <div className="flex min-w-0 items-center gap-1">
              <Button
                isIconOnly
                size="sm"
                variant="tertiary"
                aria-label={t("limits.refresh")}
                isPending={refreshing}
                onPress={() => onRefresh(row.id)}
              >
                {({ isPending }) => (isPending ? <Spinner color="current" size="sm" /> : <RefreshCw size={14} aria-hidden />)}
              </Button>
              {limits ? <span className="truncate">{t("limits.updated", { when: format.relativeTime(new Date(limits.fetchedAt), now) })}</span> : null}
            </div>
          ) : null}
        </div>
        <ProviderActions row={row} onEdit={onEdit} onImport={onImport} onDeleted={onDeleted} />
      </Card.Footer>
    </Card>
  );
}
