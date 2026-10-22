"use client";

import { Button, Chip, Skeleton, Table } from "@heroui/react";
import {
  Download,
  Info,
  Link2,
  LogIn,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  TimerReset,
  Unplug,
  Users,
} from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import { PlanBadge } from "@/components/console/subscription-badge";
import { kindIcon } from "@/components/providers/kind-icons";
import { reportsLimits } from "@/lib/gateway/upstreams/provider-kinds";
import type { AccountStrategy, LimitSnapshot, ProviderView, SignInKind } from "@/types/providers";
import type { AutoResetPolicy } from "@/types/resets";
import { STRATEGY_ICONS } from "./account-routing-picker";
import { accountMenuActions, accountRow, type AccountMenuAction, type AccountRow } from "./account-rows";
import { ACCOUNT_STATE_COLOR, type CountedState } from "./account-status";
import LimitMeter from "./limit-meter";
import RowMenu, { type RowMenuItem } from "./row-menu";

const MENU_ICONS = {
  details: Info,
  refresh: RefreshCw,
  signIn: LogIn,
  edit: Pencil,
  access: Users,
  pause: Pause,
  resume: Play,
  import: Download,
  disconnect: Unplug,
} as const;

type GroupAction = "settings" | "link";

export default function SubscriptionGroup({
  kind,
  rows,
  total,
  counts,
  limits,
  settingsLoaded,
  strategy,
  autoReset,
  canManage,
  timeZone,
  isBusy,
  onAdd,
  onSettings,
  onCreateLink,
  onMenu,
}: {
  kind: SignInKind;
  rows: ProviderView[];
  total: number;
  counts: { state: CountedState; count: number }[];
  limits: Record<string, LimitSnapshot>;
  settingsLoaded: boolean;
  strategy: AccountStrategy;
  autoReset: AutoResetPolicy | null;
  canManage: boolean;
  timeZone: string;
  isBusy: (id: string) => boolean;
  onAdd: () => void;
  onSettings: () => void;
  onCreateLink: () => void;
  onMenu: (row: ProviderView, action: AccountMenuAction) => void;
}) {
  const t = useTranslations("Subscriptions");
  const tRouting = useTranslations("Subscriptions.routing");
  const tProviders = useTranslations("Providers");
  const tError = useTranslations("Error");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const name = tProviders("kindShort", { kind });
  const StrategyIcon = STRATEGY_ICONS[strategy];
  const titleId = `subscriptions-${kind}`;
  const reports = reportsLimits(kind);
  const accounts = rows.map((row) => ({ row, account: accountRow(row, limits[row.id], reports, now.getTime()) }));

  const groupItems: RowMenuItem<GroupAction>[] = [
    { id: "settings", label: t("group.settings", { resets: String(autoReset !== null) }), icon: SlidersHorizontal },
    { id: "link", label: t("group.createLink", { provider: name }), icon: Link2 },
  ];

  function menuLabel(action: AccountMenuAction) {
    if (action === "details") return t("menu.details");
    if (action === "refresh") return t("menu.refresh");
    if (action === "signIn") return t("menu.signIn");
    if (action === "edit") return tCommon("edit");
    if (action === "access") return t("menu.access");
    if (action === "pause") return tProviders("menu.pause");
    if (action === "resume") return tProviders("menu.resume");
    if (action === "import") return tProviders("importModels");
    return tProviders("menu.disconnect");
  }

  function menu(row: ProviderView, account: AccountRow) {
    const items: RowMenuItem<AccountMenuAction>[] = accountMenuActions(canManage, row, account).map((action) => ({
      id: action,
      label: menuLabel(action),
      icon: MENU_ICONS[action],
      danger: action === "disconnect",
      disabled: action === "refresh" && account.held,
    }));
    return (
      <RowMenu
        label={t("menu.label", { name: account.title })}
        items={items}
        pending={isBusy(row.id)}
        onAction={(action) => onMenu(row, action)}
      />
    );
  }

  function stamp(time: number) {
    return format.dateTime(new Date(time), {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone,
      timeZoneName: "short",
    });
  }

  function accountChips(account: AccountRow) {
    return (
      <>
        <PlanBadge plan={account.plan} />
        {account.sharedVia !== null ? (
          <Chip size="sm" variant="soft" color="accent" className="whitespace-nowrap">
            <Link2 size={12} aria-hidden />
            {t("sharedVia", { named: String(account.sharedVia !== ""), label: account.sharedVia })}
          </Chip>
        ) : null}
        {account.manageOff ? (
          <Chip size="sm" variant="soft" className="whitespace-nowrap">
            {t("manageOff")}
          </Chip>
        ) : null}
      </>
    );
  }

  function statusChips(account: AccountRow) {
    return (
      <>
        <Chip size="sm" variant="soft" color={ACCOUNT_STATE_COLOR[account.state]} className="whitespace-nowrap">
          {t("status", { status: account.state })}
        </Chip>
        {account.partial ? (
          <Chip size="sm" variant="soft" color="warning" className="whitespace-nowrap">
            {t("limits.partial", { reached: account.partial.reached, total: account.partial.total })}
          </Chip>
        ) : null}
      </>
    );
  }

  function signIn(row: ProviderView, account: AccountRow) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-xs text-danger">{t("expiredHint")}</p>
        {canManage ? (
          <Button
            size="sm"
            variant="danger-soft"
            aria-label={t("menu.signInFor", { name: account.title })}
            onPress={() => onMenu(row, "signIn")}
          >
            <LogIn size={14} aria-hidden />
            {t("menu.signIn")}
          </Button>
        ) : null}
      </div>
    );
  }

  function usage(row: ProviderView, account: AccountRow) {
    if (account.needsSignIn && account.summary.groups.length === 0) return signIn(row, account);
    if (!reports) return <p className="text-xs text-muted">{t("noLimits")}</p>;
    if (account.state === "checking") {
      return (
        <div className="space-y-3" aria-hidden>
          {[0, 1].map((item) => (
            <div key={item} className="space-y-2">
              <Skeleton className="h-3 w-1/2 rounded-lg" />
              <Skeleton className="h-2 w-full rounded-lg" />
            </div>
          ))}
        </div>
      );
    }
    if (account.summary.groups.length === 0) {
      if (account.failure) return <p className="text-xs text-warning">{tError("code", { code: account.failure })}</p>;
      if (account.limits) return <p className="text-xs text-muted">{t("limits.none")}</p>;
      return <p className="text-xs text-muted">{tCommon("none")}</p>;
    }
    return (
      <div className="space-y-3">
        {account.needsSignIn ? signIn(row, account) : null}
        {account.summary.groups.map((group) => (
          <LimitMeter key={group.id} group={group} timeZone={timeZone} compact />
        ))}
        {account.detailed ? (
          <Button
            size="sm"
            variant="ghost"
            aria-label={t("limits.allLimitsFor", { count: account.groups.length, name: account.title })}
            onPress={() => onMenu(row, "details")}
          >
            {t("limits.allLimits", { count: account.groups.length })}
          </Button>
        ) : null}
      </div>
    );
  }

  function nextReset(account: AccountRow) {
    if (reports && account.state === "checking") return <Skeleton className="h-3.5 w-24 rounded-lg" />;
    if (account.nextReset === null) {
      return (
        <span className="text-sm text-muted">
          {account.state === "limited" ? t("resetUnknown") : tCommon("none")}
        </span>
      );
    }
    const at = new Date(account.nextReset);
    return (
      <span className="flex flex-col">
        <span className={account.state === "limited" ? "text-sm text-warning" : "text-sm text-foreground"}>
          {format.relativeTime(at, now)}
        </span>
        <span className="text-xs text-muted">{stamp(account.nextReset)}</span>
      </span>
    );
  }

  function access(account: AccountRow) {
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-sm whitespace-nowrap text-foreground">
        <Users size={14} aria-hidden className={account.restricted ? "shrink-0 text-warning" : "shrink-0 text-muted"} />
        {t("access.short", { restricted: String(account.restricted), count: account.assignments })}
      </span>
    );
  }

  return (
    <section aria-labelledby={titleId} className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 basis-72 items-start gap-3">
          <IconTile icon={kindIcon(kind)} />
          <div className="min-w-0 flex-1 space-y-2">
            <h2 id={titleId} className="text-base font-semibold break-words text-foreground">
              {t.rich("group.title", {
                provider: name,
                channel: tProviders("channel", { kind }),
                count: total,
                muted: (chunks) => <span className="font-normal text-muted">{chunks}</span>,
              })}
            </h2>
            <div className="flex flex-wrap items-center gap-1">
              {counts.map(({ state, count }) => (
                <Chip key={state} size="sm" variant="soft" color={ACCOUNT_STATE_COLOR[state]} className="whitespace-nowrap">
                  {t("stateCount", { state, count })}
                </Chip>
              ))}
              {settingsLoaded ? (
                <>
                  <Chip size="sm" variant="soft" className="whitespace-nowrap">
                    <StrategyIcon size={12} aria-hidden />
                    {t("settings.routingSummary", { method: tRouting("method", { strategy }) })}
                  </Chip>
                  {autoReset ? (
                    <Chip
                      size="sm"
                      variant="soft"
                      color={autoReset.enabled ? "success" : "default"}
                      className="whitespace-nowrap"
                    >
                      <TimerReset size={12} aria-hidden />
                      {t("settings.autoResetSummary", {
                        enabled: String(autoReset.enabled),
                        percent: format.number(autoReset.percent / 100, { style: "percent" }),
                      })}
                    </Chip>
                  ) : null}
                </>
              ) : (
                <Skeleton className="h-5 w-40 rounded-2xl" />
              )}
            </div>
          </div>
        </div>
        {canManage ? (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              aria-label={tProviders("formTitle", { mode: "connect", name: tProviders("kindName", { kind }) })}
              onPress={onAdd}
            >
              <Plus size={14} aria-hidden />
              {t("addAccount")}
            </Button>
            <RowMenu
              label={t("group.menu", { provider: name })}
              items={groupItems}
              onAction={(action) => {
                if (action === "settings") onSettings();
                if (action === "link") onCreateLink();
              }}
            />
          </div>
        ) : null}
      </div>

      <RowCards label={t("group.label", { provider: name })}>
        {accounts.map(({ row, account }) => (
          <RowCard
            key={row.id}
            title={account.title}
            description={account.subtitle ?? t("noAccount")}
            aside={menu(row, account)}
            chips={
              <>
                {statusChips(account)}
                {accountChips(account)}
              </>
            }
            details={[
              { label: t("columns.usage"), value: usage(row, account), wide: true },
              { label: t("columns.nextReset"), value: nextReset(account) },
              { label: t("columns.access"), value: access(account) },
            ]}
          />
        ))}
      </RowCards>
      <Table aria-label={t("group.label", { provider: name })} className={TABLE_FROM_LG}>
        <Table.ScrollContainer>
          <Table.Content aria-label={t("group.label", { provider: name })} className="min-w-[56rem]">
            <Table.Header>
              <Table.Column isRowHeader>{t("columns.account")}</Table.Column>
              <Table.Column>{tCommon("status")}</Table.Column>
              <Table.Column>{t("columns.usage")}</Table.Column>
              <Table.Column>{t("columns.nextReset")}</Table.Column>
              <Table.Column>{t("columns.access")}</Table.Column>
              <Table.Column>{tCommon("actions")}</Table.Column>
            </Table.Header>
            <Table.Body>
              {accounts.map(({ row, account }) => (
                <Table.Row key={row.id} id={row.id}>
                  <Table.Cell>
                    <div className="min-w-0 space-y-1">
                      <div>
                        <p className="text-sm font-medium break-words">{account.title}</p>
                        <p className="text-xs break-words text-muted">{account.subtitle ?? t("noAccount")}</p>
                      </div>
                      <div className="flex flex-wrap gap-1">{accountChips(account)}</div>
                    </div>
                  </Table.Cell>
                  <Table.Cell>
                    <div className="flex flex-wrap gap-1">{statusChips(account)}</div>
                  </Table.Cell>
                  <Table.Cell>
                    <div className="min-w-56">{usage(row, account)}</div>
                  </Table.Cell>
                  <Table.Cell>{nextReset(account)}</Table.Cell>
                  <Table.Cell>{access(account)}</Table.Cell>
                  <Table.Cell>{menu(row, account)}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
    </section>
  );
}
