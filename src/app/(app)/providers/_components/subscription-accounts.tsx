"use client";

import { useEffect, useState, useTransition } from "react";
import { Button, Card, Chip, Spinner, useOverlayState } from "@heroui/react";
import { CircleCheck, CirclePause, Gauge, Plus, RefreshCw, TimerReset } from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
import StatCard from "@/components/console/stat-card";
import { useErrorToast } from "@/components/console/use-error-toast";
import { DEFAULT_ACCOUNT_STRATEGY } from "@/lib/gateway/routing/account-access";
import { isSignInKind, PROVIDER_CATALOG, reportsLimits } from "@/lib/gateway/upstreams/provider-kinds";
import { isActionFail } from "@/lib/http/action-result";
import type {
  AccountLimits,
  AccountRouting,
  AccountState,
  ProviderKindSpec,
  ProviderListActions,
  ProviderView,
  SignInKind,
} from "@/types/providers";
import {
  loadAccountRoutingAction,
  loadAntigravityConfigAction,
  loadProviderLimitsAction,
  loadSubscriptionLimitsAction,
} from "../_action";
import AccessDialog from "./access-dialog";
import AccountCard from "./account-card";
import AccountRoutingPicker from "./account-routing-picker";
import { ACCOUNT_STATE_COLOR, accountState, recoveryAt } from "./account-status";
import AntigravitySetup from "./antigravity-setup";
import { kindIcon } from "./kind-icons";

const SUBSCRIPTION_CATALOG = PROVIDER_CATALOG.filter((spec): spec is ProviderKindSpec & { kind: SignInKind } =>
  isSignInKind(spec.kind),
);

const COUNTED_STATES = ["available", "limited", "expired", "paused"] as const satisfies readonly AccountState[];

function countedState(state: AccountState): (typeof COUNTED_STATES)[number] | null {
  if (state === "connected") return "available";
  return COUNTED_STATES.find((item) => item === state) ?? null;
}

export default function SubscriptionAccounts({
  rows,
  actions,
}: {
  rows: ProviderView[];
  actions: ProviderListActions;
}) {
  const t = useTranslations("Subscriptions");
  const tProviders = useTranslations("Providers");
  const showError = useErrorToast();
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const [limits, setLimits] = useState<Record<string, AccountLimits>>({});
  const [routing, setRouting] = useState<AccountRouting>({});
  const [antigravityReady, setAntigravityReady] = useState<boolean | null>(null);
  const [access, setAccess] = useState<ProviderView | null>(null);
  const [accessKey, setAccessKey] = useState(0);
  const [refreshingId, setRefreshingId] = useState("");
  const [refreshingAll, startRefreshAll] = useTransition();
  const [, startRefreshOne] = useTransition();
  const accessState = useOverlayState();

  function storeLimits(items: AccountLimits[]) {
    setLimits((cur) => ({ ...cur, ...Object.fromEntries(items.map((item) => [item.id, item])) }));
  }

  useEffect(() => {
    let active = true;
    loadSubscriptionLimitsAction().then((res) => {
      if (active && !isActionFail(res)) storeLimits(res.items);
    });
    loadAccountRoutingAction().then((res) => {
      if (active && !isActionFail(res)) setRouting(res.routing);
    });
    loadAntigravityConfigAction().then((res) => {
      if (active && !isActionFail(res)) setAntigravityReady(res.configured);
    });
    return () => {
      active = false;
    };
  }, []);

  function refreshAll() {
    startRefreshAll(async () => {
      const result = await loadSubscriptionLimitsAction({ refresh: true });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      storeLimits(result.items);
    });
  }

  function refreshOne(id: string) {
    setRefreshingId(id);
    startRefreshOne(async () => {
      const result = await loadProviderLimitsAction({ id, refresh: true });
      setRefreshingId("");
      storeLimits([
        isActionFail(result) ? { id, limits: null, error: result.error } : { id, limits: result.limits, error: "" },
      ]);
    });
  }

  function openForm(spec: ProviderKindSpec, row: ProviderView | null) {
    actions.openForm(spec, row, (provider) => {
      if (reportsLimits(provider.kind)) refreshOne(provider.id);
    });
  }

  function openAccess(row: ProviderView) {
    setAccess(row);
    setAccessKey((n) => n + 1);
    accessState.open();
  }

  const counted = new Map(
    rows.map((row) => [row.id, countedState(accountState(row, limits[row.id], reportsLimits(row.kind)))]),
  );
  const tally = (state: (typeof COUNTED_STATES)[number], subset: ProviderView[] = rows) =>
    subset.filter((row) => counted.get(row.id) === state).length;
  const recoveries = rows
    .filter((row) => counted.get(row.id) === "limited")
    .map((row) => recoveryAt(limits[row.id], now.getTime()))
    .filter((time): time is number => time !== null);
  const nextRecovery = recoveries.length ? Math.min(...recoveries) : null;
  const connectedKinds = SUBSCRIPTION_CATALOG.filter((spec) => rows.some((row) => row.kind === spec.kind));
  const idleKinds = SUBSCRIPTION_CATALOG.filter((spec) => !rows.some((row) => row.kind === spec.kind));

  function addButton(spec: ProviderKindSpec) {
    return (
      <Button
        size="sm"
        variant="secondary"
        isDisabled={spec.kind === "antigravity" && antigravityReady === false}
        aria-label={tProviders("formTitle", { mode: "connect", name: tProviders("kindName", { kind: spec.kind }) })}
        onPress={() => openForm(spec, null)}
      >
        <Plus size={14} aria-hidden />
        {t("addAccount")}
      </Button>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="min-w-0 flex-1 basis-72 text-sm text-muted">{t("intro")}</p>
        {rows.length > 0 ? (
          <Button variant="secondary" aria-label={t("refreshAll")} isPending={refreshingAll} onPress={refreshAll}>
            {({ isPending }) => (
              <>
                {isPending ? <Spinner color="current" size="sm" /> : <RefreshCw size={14} aria-hidden />}
                {t("refreshAll")}
              </>
            )}
          </Button>
        ) : null}
      </div>

      {rows.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <StatCard
            icon={CircleCheck}
            tone="success"
            label={t("stats.available")}
            value={format.number(tally("available"))}
            hint={t("stats.total", { count: rows.length })}
          />
          <StatCard
            icon={Gauge}
            tone="warning"
            label={t("stats.limited")}
            value={format.number(tally("limited"))}
          />
          <StatCard
            icon={CirclePause}
            tone="neutral"
            label={t("stats.paused")}
            value={format.number(tally("paused"))}
          />
          <StatCard
            icon={TimerReset}
            tone="accent"
            label={t("stats.nextRecovery")}
            value={nextRecovery ? format.relativeTime(new Date(nextRecovery), now) : t("stats.none")}
          />
        </div>
      ) : null}

      {connectedKinds.map((spec) => {
        const items = rows.filter((row) => row.kind === spec.kind);
        return (
          <Card key={spec.kind} className="gap-5">
            <Card.Header className="flex-row flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 flex-1 basis-72 items-start gap-3">
                <IconTile icon={kindIcon(spec.kind)} />
                <div className="min-w-0 flex-1 space-y-2">
                  <div>
                    <Card.Title>{tProviders("kindName", { kind: spec.kind })}</Card.Title>
                    <Card.Description>{tProviders("kindDescription", { kind: spec.kind })}</Card.Description>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {COUNTED_STATES.map((state) => {
                      const count = tally(state, items);
                      return count ? (
                        <Chip key={state} size="sm" variant="soft" color={ACCOUNT_STATE_COLOR[state]}>
                          {t("stateCount", { state, count })}
                        </Chip>
                      ) : null;
                    })}
                  </div>
                </div>
              </div>
              {addButton(spec)}
            </Card.Header>
            <Card.Content className="gap-5">
              {spec.kind === "antigravity" ? (
                <AntigravitySetup configured={antigravityReady} onChanged={setAntigravityReady} />
              ) : null}
              <AccountRoutingPicker
                kind={spec.kind}
                strategy={routing[spec.kind] ?? DEFAULT_ACCOUNT_STRATEGY}
                accounts={items.length}
                onSaved={setRouting}
              />
              <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                {items.map((row) => (
                  <AccountCard
                    key={row.id}
                    row={row}
                    reports={reportsLimits(row.kind)}
                    entry={limits[row.id]}
                    refreshing={refreshingId === row.id}
                    onRefresh={refreshOne}
                    onEdit={(provider) => openForm(spec, provider)}
                    onImport={actions.openImport}
                    onAccess={openAccess}
                    onToggled={actions.replace}
                    onDeleted={actions.remove}
                  />
                ))}
              </div>
            </Card.Content>
          </Card>
        );
      })}

      {idleKinds.length > 0 ? (
        <section className="space-y-3" aria-labelledby="subscriptions-connect">
          <h2 id="subscriptions-connect" className="text-base font-semibold tracking-tight">
            {t("connectTitle", { first: String(rows.length === 0) })}
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            {idleKinds.map((spec) => (
              <Card key={spec.kind}>
                <Card.Header className="flex-row items-start gap-3">
                  <IconTile icon={kindIcon(spec.kind)} tone="neutral" />
                  <div className="min-w-0 flex-1">
                    <Card.Title>{tProviders("kindName", { kind: spec.kind })}</Card.Title>
                    <Card.Description>{tProviders("kindDescription", { kind: spec.kind })}</Card.Description>
                  </div>
                </Card.Header>
                {spec.kind === "antigravity" ? (
                  <Card.Content>
                    <AntigravitySetup configured={antigravityReady} onChanged={setAntigravityReady} />
                  </Card.Content>
                ) : null}
                <Card.Footer className="mt-auto justify-end">{addButton(spec)}</Card.Footer>
              </Card>
            ))}
          </div>
        </section>
      ) : null}

      <AccessDialog key={`access-${accessKey}`} state={accessState} provider={access} onSaved={actions.replace} />
    </div>
  );
}
