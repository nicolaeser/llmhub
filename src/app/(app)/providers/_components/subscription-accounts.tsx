"use client";

import { useEffect, useState } from "react";
import { Button, Spinner, useOverlayState } from "@heroui/react";
import { CircleCheck, CirclePause, Gauge, KeyRound, Plus, RefreshCw, UserRound } from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import EmptyState from "@/components/console/empty-state";
import { LoadError } from "@/components/console/page-status";
import StatCard from "@/components/console/stat-card";
import TimeZonePicker from "@/components/console/time-zone-picker";
import { DEFAULT_ACCOUNT_STRATEGY } from "@/lib/gateway/routing/account-access";
import { autoResetPolicy, isResetKind } from "@/lib/gateway/routing/auto-reset-policy";
import { reportsLimits } from "@/lib/gateway/upstreams/provider-kinds";
import { setDashboardTimeZone, useDashboardTimeZone } from "@/lib/hooks/use-dashboard-time-zone";
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
import { accountState, byAccountOrder, COUNTED_STATES, countedState, recoveryAt, type CountedState } from "./account-status";
import ProviderSection from "./provider-section";
import ProviderSettingsDialog from "./provider-settings-dialog";
import { SUBSCRIPTION_CATALOG } from "./provider-options";
import type { AccountLimitsState } from "./use-account-limits";

export default function SubscriptionAccounts({
  rows,
  actions,
  canManage,
  limits,
  antigravity,
  onAntigravity,
  onAdd,
}: {
  rows: ProviderView[];
  actions: ProviderListActions;
  canManage: boolean;
  limits: AccountLimitsState;
  antigravity: AntigravityClientState | null;
  onAntigravity: (state: AntigravityClientState) => void;
  onAdd: (kind: SignInKind | null) => void;
}) {
  const t = useTranslations("Subscriptions");
  const tProviders = useTranslations("Providers");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const timeZone = useDashboardTimeZone();
  const [routing, setRouting] = useState<AccountRouting | null>(null);
  const [autoReset, setAutoReset] = useState<AutoResetPolicies>({});
  const [access, setAccess] = useState<ProviderView | null>(null);
  const [accessKey, setAccessKey] = useState(0);
  const [settingsKind, setSettingsKind] = useState<SignInKind | null>(null);
  const accessState = useOverlayState();
  const settingsState = useOverlayState();
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
    rows.map((row) => [row.id, countedState(accountState(row, items[row.id], reportsLimits(row.kind)))]),
  );
  const tally = (state: CountedState, subset: ProviderView[] = rows) =>
    subset.filter((row) => states.get(row.id) === state).length;
  const recoveries = rows
    .filter((row) => states.get(row.id) === "limited")
    .map((row) => recoveryAt(items[row.id], now.getTime()))
    .filter((time): time is number => time !== null);
  const nextRecovery = recoveries.length ? Math.min(...recoveries) : null;
  const connected = SUBSCRIPTION_CATALOG.filter((spec) => rows.some((row) => row.kind === spec.kind));
  const available = tally("available");
  const limited = tally("limited");
  const expired = tally("expired");
  const paused = tally("paused");

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4">
        <p className="max-w-3xl text-sm text-muted">{t("intro")}</p>
        <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-end md:justify-between">
          <div>
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
            <TimeZonePicker label={t("timeZone")} value={timeZone} isDisabled={false} onChange={setDashboardTimeZone} />
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
          hint={nextRecovery ? t("stats.nextFree", { when: format.relativeTime(new Date(nextRecovery), now) }) : undefined}
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

      {connected.map((spec) => {
        const accounts = rows.filter((row) => row.kind === spec.kind).sort(byAccountOrder);
        return (
          <ProviderSection
            key={spec.kind}
            kind={spec.kind}
            rows={accounts}
            counts={COUNTED_STATES.map((state) => ({ state, count: tally(state, accounts) })).filter((item) => item.count > 0)}
            limits={items}
            settingsLoaded={routing !== null}
            strategy={routing?.[spec.kind] ?? DEFAULT_ACCOUNT_STRATEGY}
            autoReset={isResetKind(spec.kind) ? (autoReset[spec.kind] ?? autoResetPolicy({})) : null}
            canManage={canManage}
            timeZone={timeZone}
            refreshing={limits.refreshing}
            onAdd={() => onAdd(spec.kind)}
            onSettings={() => openSettings(spec.kind)}
            onRefresh={limits.refreshOne}
            onItem={limits.storeItem}
            onEdit={(provider) => actions.openForm(spec, provider)}
            onImport={actions.openImport}
            onAccess={openAccess}
            onToggled={actions.replace}
            onDeleted={actions.remove}
          />
        );
      })}

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
        </>
      ) : null}
    </div>
  );
}
