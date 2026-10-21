"use client";

import { Button, Card, Chip, Disclosure, Separator, Skeleton, Spinner } from "@heroui/react";
import {
  CircleAlert,
  CircleCheck,
  CirclePause,
  CloudOff,
  Gauge,
  KeyRound,
  Link2,
  LoaderCircle,
  RefreshCw,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
import { PlanBadge } from "@/components/console/subscription-badge";
import { limitGroups, summaryGroups } from "@/lib/gateway/upstreams/limit-groups";
import { limitsUpdatedAt, updatedFromTraffic } from "@/lib/gateway/upstreams/observed-limits";
import PolicyChips from "./policy-chips";
import ProviderActions from "./provider-actions";
import ProviderToggle from "./provider-toggle";
import type { AccountState, LimitSnapshot, ProviderView } from "@/types/providers";
import type { Tone } from "@/types/console";
import { ACCOUNT_STATE_COLOR, accountState, partialLimits, recoveryAt } from "./account-status";
import BankedResets from "./banked-resets";
import LimitMeter from "./limit-meter";

const STATE_ICON: Record<AccountState, LucideIcon> = {
  available: CircleCheck,
  connected: CircleCheck,
  limited: Gauge,
  expired: KeyRound,
  unavailable: CloudOff,
  checking: LoaderCircle,
  paused: CirclePause,
};

const STATE_TONE: Record<AccountState, Tone> = {
  available: "success",
  connected: "success",
  limited: "warning",
  expired: "danger",
  unavailable: "warning",
  checking: "neutral",
  paused: "neutral",
};

export default function AccountCard({
  row,
  reports,
  entry,
  timeZone,
  refreshing,
  canManage,
  onRefresh,
  onItem,
  onEdit,
  onImport,
  onAccess,
  onDeleted,
  onToggled,
}: {
  row: ProviderView;
  reports: boolean;
  entry: LimitSnapshot | undefined;
  timeZone: string;
  refreshing: boolean;
  canManage: boolean;
  onRefresh: (id: string) => void;
  onItem: (item: LimitSnapshot | null) => void;
  onEdit: (row: ProviderView) => void;
  onImport: (row: ProviderView) => void;
  onAccess: (row: ProviderView) => void;
  onDeleted: (id: string) => void;
  onToggled: (provider: ProviderView) => void;
}) {
  const t = useTranslations("Subscriptions");
  const tError = useTranslations("Error");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const state = accountState(row, entry, reports, now.getTime());
  const limits = entry?.limits ?? null;
  const groups = limitGroups(row.kind, limits, now.getTime());
  const summary = summaryGroups(groups);
  const detailed = summary.more > 0 || groups.some((group) => group.members.length > 1);
  const partial = state === "available" ? partialLimits(row, entry, now.getTime()) : null;
  const recovery = state === "limited" ? recoveryAt(row, entry, now.getTime()) : null;
  const plan = limits?.plan || row.signIn?.plan || "";
  const account = row.signIn?.account ?? "";
  const failure = entry?.error && entry.error !== "SIGN_IN_EXPIRED" ? entry.error : "";
  const nextCheck = failure && entry?.nextAt ? new Date(Math.max(Date.parse(entry.nextAt), now.getTime())) : null;
  const held = entry?.retryAt ? Date.parse(entry.retryAt) > now.getTime() : false;

  return (
    <Card variant="secondary" className="min-w-0 gap-4">
      <Card.Header className="flex-row flex-wrap items-start gap-3">
        <IconTile icon={STATE_ICON[state]} tone={STATE_TONE[state]} />
        <div className="min-w-0 flex-1 basis-40">
          <Card.Title className="truncate">{account || row.name}</Card.Title>
          <Card.Description className="truncate">{account ? row.name : t("noAccount")}</Card.Description>
        </div>
        <div className="flex max-w-full flex-wrap justify-end gap-1">
          <PlanBadge plan={plan} />
          <Chip size="sm" variant="soft" color={ACCOUNT_STATE_COLOR[state]} className="whitespace-nowrap">
            {t("status", { status: state })}
          </Chip>
          {partial ? (
            <Chip size="sm" variant="soft" color="warning" className="whitespace-nowrap">
              {t("limits.partial", { reached: partial.reached, total: partial.total })}
            </Chip>
          ) : null}
        </div>
      </Card.Header>

      <Card.Content className="gap-4">
        <PolicyChips
          policy={row.policy}
          lead={
            row.sharedVia !== null ? (
              <Chip size="sm" variant="soft" color="accent" className="whitespace-nowrap">
                <Link2 size={12} aria-hidden />
                {t("sharedVia", { named: String(row.sharedVia !== ""), label: row.sharedVia })}
              </Chip>
            ) : null
          }
        />

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
        {state === "expired" ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex min-w-0 items-center gap-2 text-sm text-danger">
              <CircleAlert size={14} aria-hidden className="shrink-0" />
              {t("expiredHint")}
            </p>
            {canManage ? (
              <Button size="sm" variant="danger-soft" onPress={() => onEdit(row)}>
                <KeyRound size={14} aria-hidden />
                {t("signInAgain")}
              </Button>
            ) : null}
          </div>
        ) : null}
        {state === "paused" ? <p className="text-sm text-muted">{t("pausedHint")}</p> : null}
        {failure ? (
          <div className="space-y-1">
            <p className="text-sm text-warning">{tError("code", { code: failure })}</p>
            {nextCheck ? (
              <p className="text-xs text-muted">
                {t("limits.nextCheck", { when: format.relativeTime(nextCheck, now) })}
              </p>
            ) : null}
          </div>
        ) : null}
        {!reports && state !== "expired" ? <p className="text-sm text-muted">{t("noLimits")}</p> : null}

        {reports && state === "checking" ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2" aria-hidden>
            {[0, 1].map((item) => (
              <div key={item} className="space-y-2">
                <Skeleton className="h-3 w-1/2 rounded-lg" />
                <Skeleton className="h-2 w-full rounded-lg" />
                <Skeleton className="h-3 w-2/3 rounded-lg" />
              </div>
            ))}
          </div>
        ) : null}
        {limits && groups.length === 0 ? <p className="text-sm text-muted">{t("limits.none")}</p> : null}
        {summary.groups.length > 0 ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {summary.groups.map((group) => (
              <LimitMeter key={group.id} group={group} timeZone={timeZone} />
            ))}
          </div>
        ) : null}
        {detailed ? (
          <Disclosure>
            <Disclosure.Heading>
              <Disclosure.Trigger className="flex w-full items-center justify-between gap-2 text-sm text-muted">
                {t("limits.allLimits", { count: groups.length })}
                <Disclosure.Indicator />
              </Disclosure.Trigger>
            </Disclosure.Heading>
            <Disclosure.Content>
              <Disclosure.Body className="grid grid-cols-1 gap-4 pt-3 sm:grid-cols-2">
                {groups.map((group) => (
                  <LimitMeter key={group.id} group={group} withMembers timeZone={timeZone} />
                ))}
              </Disclosure.Body>
            </Disclosure.Content>
          </Disclosure>
        ) : null}
        {limits?.resetCredits ? (
          <BankedResets row={row} credits={limits.resetCredits} timeZone={timeZone} canManage={canManage} onItem={onItem} />
        ) : null}
        {limits?.extraUsage || limits?.credits ? (
          <ul className="space-y-1 text-sm text-muted">
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
                {t("limits.credits", { unlimited: limits.credits.unlimited ? "true" : "false", balance: limits.credits.balance })}
              </li>
            ) : null}
          </ul>
        ) : null}
      </Card.Content>

      <Separator />

      <Card.Footer className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          {canManage ? (
            <>
              <ProviderToggle row={row} onChanged={onToggled} />
              <Button
                size="sm"
                variant="tertiary"
                aria-label={t("access.manageFor", { name: account || row.name })}
                onPress={() => onAccess(row)}
              >
                <Users size={14} aria-hidden className={row.restricted ? "text-warning" : undefined} />
                {t("access.short", { restricted: String(row.restricted), count: row.assignments.length })}
              </Button>
            </>
          ) : (
            <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted">
              <Users size={14} aria-hidden className={row.restricted ? "shrink-0 text-warning" : "shrink-0"} />
              {t("access.summary", { restricted: String(row.restricted), count: row.assignments.length })}
            </span>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-1">
          {reports && state !== "expired" && limits ? (
            <span className="truncate text-xs text-muted">
              {t("limits.updated", {
                source: updatedFromTraffic(limits) ? "traffic" : "poll",
                when: format.relativeTime(new Date(Math.min(limitsUpdatedAt(limits), now.getTime())), now),
              })}
            </span>
          ) : null}
          {reports && state !== "expired" ? (
            <Button
              isIconOnly
              size="sm"
              variant="tertiary"
              aria-label={t("limits.refresh")}
              isPending={refreshing}
              isDisabled={held}
              onPress={() => onRefresh(row.id)}
            >
              {({ isPending }) => (isPending ? <Spinner color="current" size="sm" /> : <RefreshCw size={14} aria-hidden />)}
            </Button>
          ) : null}
          {canManage ? (
            <ProviderActions row={row} variant="menu" onEdit={onEdit} onImport={onImport} onDeleted={onDeleted} />
          ) : null}
        </div>
      </Card.Footer>
    </Card>
  );
}
