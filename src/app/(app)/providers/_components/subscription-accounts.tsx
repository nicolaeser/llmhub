"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Button, Spinner, useOverlayState } from "@heroui/react";
import { CircleCheck, CirclePause, Gauge, KeyRound, Link2, Plus, RefreshCw, Upload, UserRound } from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import EmptyState from "@/components/console/empty-state";
import { LoadError } from "@/components/console/page-status";
import StatCard from "@/components/console/stat-card";
import TimeZonePicker from "@/components/console/time-zone-picker";
import { useErrorToast } from "@/components/console/use-error-toast";
import { DEFAULT_ACCOUNT_STRATEGY } from "@/lib/gateway/routing/account-access";
import { autoResetPolicy, isResetKind } from "@/lib/gateway/routing/auto-reset-policy";
import { isSignInKind, PROVIDER_CATALOG, reportsLimits } from "@/lib/gateway/upstreams/provider-kinds";
import { useActionData } from "@/lib/hooks/use-action-data";
import { setDashboardTimeZone, useDashboardTimeZone } from "@/lib/hooks/use-dashboard-time-zone";
import { useLiveConnected, useLiveLimits } from "@/lib/hooks/use-live";
import { isActionFail } from "@/lib/http/action-result";
import { withLimitItems } from "@/lib/updates/live-events";
import type {
  AccountRouting,
  AntigravityClientState,
  LimitSnapshot,
  LimitSnapshotList,
  ProviderKindSpec,
  ProviderListActions,
  ProviderView,
  SignInKind,
} from "@/types/providers";
import type { AutoResetPolicies } from "@/types/resets";
import {
  loadAccountRoutingAction,
  loadAntigravityConfigAction,
  loadProviderLimitsAction,
  loadSubscriptionLimitsAction,
} from "../_action";
import AccessDialog from "./access-dialog";
import { accountState, byAccountOrder, COUNTED_STATES, countedState, recoveryAt, type CountedState } from "./account-status";
import AuthFilesDialog from "./auth-files-dialog";
import IdleProviders from "./idle-providers";
import ProviderSection from "./provider-section";
import ProviderSettingsDialog from "./provider-settings-dialog";
import SubAddLinks, { useSubAddLinks } from "./sub-add-links";
import SubscriptionAddWizard from "./subscription-add-wizard";

const KIND_ORDER = [
  "claude",
  "codex",
  "antigravity",
  "grok_build",
  "kimi",
  "kimi_ai",
  "muse_code",
] as const satisfies readonly SignInKind[];

function kindRank(kind: string): number {
  const index = KIND_ORDER.findIndex((item) => item === kind);
  return index === -1 ? KIND_ORDER.length : index;
}

const FALLBACK_POLL_MS = 60_000;
const RECONCILE_DELAY_MS = 6_000;

const SUBSCRIPTION_CATALOG = PROVIDER_CATALOG.filter((spec): spec is ProviderKindSpec & { kind: SignInKind } =>
  isSignInKind(spec.kind),
).sort((a, b) => kindRank(a.kind) - kindRank(b.kind));

export default function SubscriptionAccounts({
  rows,
  actions,
  canManage,
}: {
  rows: ProviderView[];
  actions: ProviderListActions;
  canManage: boolean;
}) {
  const t = useTranslations("Subscriptions");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const timeZone = useDashboardTimeZone();
  const showError = useErrorToast();
  const links = useSubAddLinks();
  const seed = useActionData<LimitSnapshotList>(() => loadSubscriptionLimitsAction());
  const { data: seedList, setData: setSeed, reload: reloadSeed } = seed;
  const { items: limits, removed } = useLiveLimits(seedList);
  const live = useLiveConnected();
  const { reload: reloadRows } = actions;
  const reconciled = useRef("");
  const [routing, setRouting] = useState<AccountRouting | null>(null);
  const [autoReset, setAutoReset] = useState<AutoResetPolicies>({});
  const [antigravity, setAntigravity] = useState<AntigravityClientState | null>(null);
  const [access, setAccess] = useState<ProviderView | null>(null);
  const [accessKey, setAccessKey] = useState(0);
  const [settingsKind, setSettingsKind] = useState<SignInKind | null>(null);
  const [refreshing, setRefreshing] = useState<string[]>([]);
  const [refreshingAll, startRefreshAll] = useTransition();
  const [, startRefreshOne] = useTransition();
  const accessState = useOverlayState();
  const settingsState = useOverlayState();
  const [importKey, setImportKey] = useState(0);
  const importState = useOverlayState();
  const wizardState = useOverlayState();

  function storeItems(items: LimitSnapshot[]) {
    if (seedList) setSeed((list) => withLimitItems(list, items));
    else reloadSeed();
  }

  function storeList(list: LimitSnapshotList) {
    if (seedList) setSeed(list);
    else reloadSeed();
  }

  useEffect(() => {
    let active = true;
    loadAccountRoutingAction().then((res) => {
      if (!active || isActionFail(res)) return;
      setRouting(res.routing);
      setAutoReset(res.autoReset);
    });
    loadAntigravityConfigAction().then((res) => {
      if (active && !isActionFail(res)) setAntigravity(res);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (live) return;
    let active = true;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      loadSubscriptionLimitsAction().then((res) => {
        if (active && !isActionFail(res)) setSeed(res);
      });
    }, FALLBACK_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [live, setSeed]);

  const antigravityReady = antigravity === null ? null : antigravity.saved || antigravity.bundled;
  const listed = new Set(rows.map((row) => row.id));
  const staleKey = [
    ...Object.keys(limits).filter((id) => !listed.has(id)),
    ...removed.filter((id) => listed.has(id)),
  ]
    .sort()
    .join(",");

  useEffect(() => {
    if (!staleKey || reconciled.current === staleKey) return;
    const timer = setTimeout(() => {
      reconciled.current = staleKey;
      reloadRows();
    }, RECONCILE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [staleKey, reloadRows]);

  function storeItem(item: LimitSnapshot | null) {
    if (item) storeItems([item]);
  }

  function refreshAll() {
    startRefreshAll(async () => {
      const result = await loadSubscriptionLimitsAction({ refresh: true });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      storeList(result);
    });
  }

  function refreshOne(id: string) {
    setRefreshing((cur) => [...cur, id]);
    startRefreshOne(async () => {
      const result = await loadProviderLimitsAction({ id, refresh: true });
      setRefreshing((cur) => cur.filter((item) => item !== id));
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      storeItem(result.item);
    });
  }

  function openForm(spec: ProviderKindSpec, row: ProviderView | null) {
    actions.openForm(spec, row, (provider) => {
      if (reportsLimits(provider.kind)) refreshOne(provider.id);
    });
  }

  function openImportFiles() {
    setImportKey((n) => n + 1);
    importState.open();
  }

  function imported(providers: ProviderView[], superseded: string[]) {
    actions.upsert(providers);
    for (const id of superseded) actions.remove(id);
    const fresh = providers.filter((provider) => reportsLimits(provider.kind) && provider.enabled);
    if (!fresh.length) return;
    startRefreshAll(async () => {
      const results = await Promise.all(
        fresh.map((provider) => loadProviderLimitsAction({ id: provider.id, refresh: true })),
      );
      storeItems(results.flatMap((result) => (isActionFail(result) || !result.item ? [] : [result.item])));
    });
  }

  function openAccess(row: ProviderView) {
    setAccess(row);
    setAccessKey((n) => n + 1);
    accessState.open();
  }

  function openSettings(kind: SignInKind) {
    setSettingsKind(kind);
    settingsState.open();
  }

  const states = new Map(
    rows.map((row) => [row.id, countedState(accountState(row, limits[row.id], reportsLimits(row.kind)))]),
  );
  const tally = (state: CountedState, subset: ProviderView[] = rows) =>
    subset.filter((row) => states.get(row.id) === state).length;
  const checking = seedList === null;
  const recoveries = rows
    .filter((row) => states.get(row.id) === "limited")
    .map((row) => recoveryAt(limits[row.id], now.getTime()))
    .filter((time): time is number => time !== null);
  const nextRecovery = recoveries.length ? Math.min(...recoveries) : null;
  const connected = SUBSCRIPTION_CATALOG.filter((spec) => rows.some((row) => row.kind === spec.kind));
  const idle = SUBSCRIPTION_CATALOG.filter((spec) => !rows.some((row) => row.kind === spec.kind));
  const available = tally("available");
  const limited = tally("limited");
  const expired = tally("expired");
  const paused = tally("paused");

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4">
        <p className="max-w-3xl text-sm text-muted">{t("intro")}</p>
        <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-end md:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            {canManage ? (
              <>
                <Button className="w-full sm:w-auto" onPress={wizardState.open}>
                  <Plus size={16} aria-hidden />
                  {t("addSubscription")}
                </Button>
                {links.canManage ? (
                  <Button variant="secondary" onPress={() => links.openCreate(null)}>
                    <Link2 size={16} aria-hidden />
                    {t("subAdd.open")}
                  </Button>
                ) : null}
                <Button variant="secondary" onPress={openImportFiles}>
                  <Upload size={16} aria-hidden />
                  {t("importFiles.open")}
                </Button>
              </>
            ) : null}
            {rows.length > 0 ? (
              <Button variant="tertiary" isPending={refreshingAll} onPress={refreshAll}>
                {({ isPending }) => (
                  <>
                    {isPending ? <Spinner color="current" size="sm" /> : <RefreshCw size={16} aria-hidden />}
                    {t("refreshAll")}
                  </>
                )}
              </Button>
            ) : null}
          </div>
          <div className="w-full md:w-72">
            <TimeZonePicker label={t("timeZone")} value={timeZone} isDisabled={false} onChange={setDashboardTimeZone} />
          </div>
        </div>
      </div>

      {rows.length > 0 ? <LoadError state={seed} /> : null}

      {rows.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <StatCard
            icon={CircleCheck}
            tone={available > 0 ? "success" : "neutral"}
            label={t("stats.available")}
            value={format.number(available)}
            pending={checking}
            hint={t("stats.total", { count: rows.length })}
          />
          <StatCard
            icon={Gauge}
            tone={limited > 0 ? "warning" : "neutral"}
            label={t("stats.limited")}
            value={format.number(limited)}
            pending={checking}
            hint={nextRecovery ? t("stats.nextFree", { when: format.relativeTime(new Date(nextRecovery), now) }) : undefined}
          />
          <StatCard
            icon={KeyRound}
            tone={expired > 0 ? "danger" : "neutral"}
            label={t("stats.expired")}
            value={format.number(expired)}
            pending={checking}
            hint={expired > 0 ? t("stats.expiredHint") : undefined}
          />
          <StatCard icon={CirclePause} tone="neutral" label={t("stats.paused")} value={format.number(paused)} />
        </div>
      ) : null}

      {connected.map((spec) => {
        const items = rows.filter((row) => row.kind === spec.kind).sort(byAccountOrder);
        return (
          <ProviderSection
            key={spec.kind}
            kind={spec.kind}
            rows={items}
            counts={COUNTED_STATES.map((state) => ({ state, count: tally(state, items) })).filter((item) => item.count > 0)}
            limits={limits}
            settingsLoaded={routing !== null}
            strategy={routing?.[spec.kind] ?? DEFAULT_ACCOUNT_STRATEGY}
            autoReset={isResetKind(spec.kind) ? (autoReset[spec.kind] ?? autoResetPolicy({})) : null}
            canManage={canManage}
            canAdd={!(spec.kind === "antigravity" && antigravityReady === false)}
            timeZone={timeZone}
            refreshing={refreshing}
            onAdd={() => openForm(spec, null)}
            onSettings={() => openSettings(spec.kind)}
            onRefresh={refreshOne}
            onItem={storeItem}
            onEdit={(provider) => openForm(spec, provider)}
            onImport={actions.openImport}
            onAccess={openAccess}
            onToggled={actions.replace}
            onDeleted={actions.remove}
          />
        );
      })}

      {!canManage && rows.length === 0 ? <EmptyState icon={UserRound} title={t("noneTitle")} /> : null}

      {canManage && idle.length > 0 ? (
        <IdleProviders
          specs={idle}
          first={rows.length === 0}
          antigravityReady={antigravityReady}
          onConnect={(spec) => openForm(spec, null)}
          onSetUp={openSettings}
          onWizard={wizardState.open}
        />
      ) : null}

      <SubAddLinks links={links} canManage={canManage} antigravityReady={antigravityReady} />

      {canManage ? (
        <>
          <SubscriptionAddWizard
            state={wizardState}
            catalog={SUBSCRIPTION_CATALOG}
            antigravityReady={antigravityReady}
            onConnect={(spec) => openForm(spec, null)}
            onShare={links.canManage ? (kind) => links.openCreate(kind) : null}
          />

          <ProviderSettingsDialog
            state={settingsState}
            kind={settingsKind}
            accounts={settingsKind ? rows.filter((row) => row.kind === settingsKind).length : 0}
            routing={routing ?? {}}
            autoReset={autoReset}
            antigravity={antigravity}
            onRouting={setRouting}
            onAutoReset={setAutoReset}
            onAntigravity={setAntigravity}
          />

          <AccessDialog key={`access-${accessKey}`} state={accessState} provider={access} onSaved={actions.replace} />

          <AuthFilesDialog key={`import-files-${importKey}`} state={importState} onImported={imported} />
        </>
      ) : null}
    </div>
  );
}
