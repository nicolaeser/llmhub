"use client";

import { useEffect, useState } from "react";
import { Button, SearchField, Spinner, useOverlayState } from "@heroui/react";
import { CircleCheck, CirclePause, Gauge, KeyRound, Plus, RefreshCw, UserRound } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import EmptyState from "@/components/console/empty-state";
import { LoadError } from "@/components/console/page-status";
import StatCard from "@/components/console/stat-card";
import TimeZonePicker from "@/components/console/time-zone-picker";
import { DEFAULT_ACCOUNT_STRATEGY } from "@/lib/gateway/routing/account-access";
import { autoResetPolicy, isResetKind } from "@/lib/gateway/routing/auto-reset-policy";
import { reportsLimits } from "@/lib/gateway/upstreams/provider-kinds";
import { setConsoleTimeZone, useConsoleTimeZone } from "@/lib/hooks/use-console-time-zone";
import { isActionFail } from "@/lib/http/action-result";
import type {
  AccountRouting,
  AntigravityClientState,
  ProviderListActions,
  ProviderView,
  SignInKind,
} from "@/types/providers";
import type { AutoResetPolicies } from "@/types/resets";
import { loadAccountRoutingAction } from "../_action";
import AccessDialog from "./access-dialog";
import AccountDetailsDialog from "./account-details-dialog";
import { accountMatches, type AccountMenuAction } from "./account-rows";
import { accountState, byAccountOrder, COUNTED_STATES, countedState, recoveryAt, type CountedState } from "./account-status";
import ProviderSettingsDialog from "./provider-settings-dialog";
import { SUBSCRIPTION_CATALOG } from "./provider-options";
import SubscriptionGroup from "./subscription-group";
import type { AccountLimitsState } from "./use-account-limits";
import { useProviderRowActions } from "./use-provider-row-actions";
import { useResetTime } from "./use-reset-time";

export default function SubscriptionAccounts({
  rows,
  actions,
  canManage,
  limits,
  antigravity,
  onAntigravity,
  onAdd,
  onCreateLink,
}: {
  rows: ProviderView[];
  actions: ProviderListActions;
  canManage: boolean;
  limits: AccountLimitsState;
  antigravity: AntigravityClientState | null;
  onAntigravity: (state: AntigravityClientState) => void;
  onAdd: (kind: SignInKind | null) => void;
  onCreateLink: (kind: SignInKind) => void;
}) {
  const t = useTranslations("Subscriptions");
  const tProviders = useTranslations("Providers");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const timeZone = useConsoleTimeZone();
  const reset = useResetTime(timeZone);
  const { now } = reset;
  const [routing, setRouting] = useState<AccountRouting | null>(null);
  const [autoReset, setAutoReset] = useState<AutoResetPolicies>({});
  const [access, setAccess] = useState<ProviderView | null>(null);
  const [accessKey, setAccessKey] = useState(0);
  const [settingsKind, setSettingsKind] = useState<SignInKind | null>(null);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const accessState = useOverlayState();
  const settingsState = useOverlayState();
  const detailsState = useOverlayState();
  const rowActions = useProviderRowActions({ onReplace: actions.replace, onRemove: actions.remove });
  const { items } = limits;

  useEffect(() => {
    let active = true;
    loadAccountRoutingAction().then((res) => {
      if (!active || isActionFail(res)) return;
      setRouting(res.routing);
      setAutoReset(res.autoReset);
    });
    return () => {
      active = false;
    };
  }, []);

  function openAccess(row: ProviderView) {
    setAccess(row);
    setAccessKey((n) => n + 1);
    accessState.open();
  }

  function openSettings(kind: SignInKind) {
    setSettingsKind(kind);
    settingsState.open();
  }

  function openDetails(row: ProviderView) {
    setDetailsId(row.id);
    detailsState.open();
  }

  function runMenu(row: ProviderView, action: AccountMenuAction) {
    if (action === "details") openDetails(row);
    if (action === "refresh") limits.refreshOne(row.id);
    if (action === "signIn" || action === "edit") {
      actions.openForm(SUBSCRIPTION_CATALOG.find((spec) => spec.kind === row.kind) ?? null, row);
    }
    if (action === "access") openAccess(row);
    if (action === "pause") rowActions.setEnabled(row, false);
    if (action === "resume") rowActions.setEnabled(row, true);
    if (action === "import") actions.openImport(row);
    if (action === "disconnect") rowActions.askDisconnect(row);
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={UserRound}
        title={t("noneTitle")}
        description={canManage ? t("empty") : undefined}
        action={
          canManage ? (
            <Button onPress={() => onAdd(null)}>
              <Plus size={16} aria-hidden />
              {tProviders("toolbar.add")}
            </Button>
          ) : undefined
        }
      />
    );
  }

  const states = new Map(
    rows.map((row) => [row.id, countedState(accountState(row, items[row.id], reportsLimits(row.kind), now.getTime()))]),
  );
  const tally = (state: CountedState, subset: ProviderView[] = rows) =>
    subset.filter((row) => states.get(row.id) === state).length;
  const recoveries = rows
    .filter((row) => states.get(row.id) === "limited")
    .map((row) => recoveryAt(row, items[row.id], now.getTime()))
    .filter((time): time is number => time !== null);
  const nextRecovery = recoveries.length ? Math.min(...recoveries) : null;
  const available = tally("available");
  const limited = tally("limited");
  const expired = tally("expired");
  const paused = tally("paused");
  const matches = (row: ProviderView) =>
    accountMatches(row, query, [
      tProviders("kindShort", { kind: row.kind }),
      tProviders("kindName", { kind: row.kind }),
      row.signIn?.plan ? tProviders("signIn.plan", { plan: row.signIn.plan }) : "",
    ]);
  const groups = SUBSCRIPTION_CATALOG.map((spec) => {
    const all = rows.filter((row) => row.kind === spec.kind);
    return { kind: spec.kind, all, shown: all.filter(matches).sort(byAccountOrder) };
  }).filter((group) => group.shown.length > 0);
  const details = detailsId ? (rows.find((row) => row.id === detailsId) ?? null) : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4">
        <p className="max-w-3xl text-sm text-muted">{t("intro")}</p>
        <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-end md:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-3 md:grow md:basis-96">
            <SearchField value={query} onChange={setQuery} aria-label={t("search")} className="w-full max-w-sm">
              <SearchField.Group>
                <SearchField.SearchIcon />
                <SearchField.Input placeholder={t("search")} />
                <SearchField.ClearButton aria-label={tCommon("close")} />
              </SearchField.Group>
            </SearchField>
            <Button variant="tertiary" isPending={limits.refreshingAll} onPress={limits.refreshAll}>
              {({ isPending }) => (
                <>
                  {isPending ? <Spinner color="current" size="sm" /> : <RefreshCw size={16} aria-hidden />}
                  {t("refreshAll")}
                </>
              )}
            </Button>
          </div>
          <div className="w-full md:w-72">
            <TimeZonePicker label={t("timeZone")} value={timeZone} isDisabled={false} onChange={setConsoleTimeZone} />
          </div>
        </div>
      </div>

      <LoadError state={limits.seed} />

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard
          icon={CircleCheck}
          tone={available > 0 ? "success" : "neutral"}
          label={t("stats.available")}
          value={format.number(available)}
          pending={limits.checking}
          hint={t("stats.total", { count: rows.length })}
        />
        <StatCard
          icon={Gauge}
          tone={limited > 0 ? "warning" : "neutral"}
          label={t("stats.limited")}
          value={format.number(limited)}
          pending={limits.checking}
          hint={nextRecovery ? t("stats.nextFree", { when: reset.countdown(nextRecovery) }) : undefined}
        />
        <StatCard
          icon={KeyRound}
          tone={expired > 0 ? "danger" : "neutral"}
          label={t("stats.expired")}
          value={format.number(expired)}
          pending={limits.checking}
          hint={expired > 0 ? t("stats.expiredHint") : undefined}
        />
        <StatCard icon={CirclePause} tone="neutral" label={t("stats.paused")} value={format.number(paused)} />
      </div>

      {groups.length === 0 ? <EmptyState icon={UserRound} title={t("noMatches")} /> : null}

      {groups.map((group) => (
        <SubscriptionGroup
          key={group.kind}
          kind={group.kind}
          rows={group.shown}
          total={group.all.length}
          counts={COUNTED_STATES.map((state) => ({ state, count: tally(state, group.all) })).filter((item) => item.count > 0)}
          limits={items}
          settingsLoaded={routing !== null}
          strategy={routing?.[group.kind] ?? DEFAULT_ACCOUNT_STRATEGY}
          autoReset={isResetKind(group.kind) ? (autoReset[group.kind] ?? autoResetPolicy({})) : null}
          canManage={canManage}
          timeZone={timeZone}
          isBusy={(id) => rowActions.busy === id || limits.refreshing.includes(id)}
          onAdd={() => onAdd(group.kind)}
          onSettings={() => openSettings(group.kind)}
          onCreateLink={() => onCreateLink(group.kind)}
          onMenu={runMenu}
        />
      ))}

      <AccountDetailsDialog
        state={detailsState}
        row={details}
        entry={details ? items[details.id] : undefined}
        reports={details ? reportsLimits(details.kind) : false}
        timeZone={timeZone}
        canManage={canManage}
        refreshing={details ? limits.refreshing.includes(details.id) : false}
        onRefresh={limits.refreshOne}
        onItem={limits.storeItem}
        onSignIn={(row) => runMenu(row, "signIn")}
      />

      {canManage ? (
        <>
          <ProviderSettingsDialog
            state={settingsState}
            kind={settingsKind}
            accounts={settingsKind ? rows.filter((row) => row.kind === settingsKind).length : 0}
            routing={routing ?? {}}
            autoReset={autoReset}
            antigravity={antigravity}
            onRouting={setRouting}
            onAutoReset={setAutoReset}
            onAntigravity={onAntigravity}
          />

          <AccessDialog key={`access-${accessKey}`} state={accessState} provider={access} onSaved={actions.replace} />
          {rowActions.dialogs}
        </>
      ) : null}
    </div>
  );
}
