"use client";

import { useEffect, useState, useTransition } from "react";
import { Button, Card, Chip, Separator, Spinner, toast, useOverlayState } from "@heroui/react";
import { Plus, RefreshCw } from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import PageHeader from "@/components/console/page-header";
import StatCard from "@/components/console/stat-card";
import ImportModelsDialog from "@/components/providers/import-models-dialog";
import ProviderDialog from "@/components/providers/provider-dialog";
import { isSignInKind, PROVIDER_CATALOG, reportsLimits } from "@/lib/gateway/catalog";
import {
  discoverProviderAction,
  loadProviderLimitsAction,
  loadProvidersAction,
  loadSubscriptionLimitsAction,
} from "@/app/(app)/providers/_action";
import { isActionFail } from "@/lib/http/action-result";
import type { AccountLimits, ImportCandidate, ProviderView } from "@/types/providers";
import AccountCard from "./_components/account-card";
import { accountState, recoveryAt } from "./_components/account-status";
import OverviewTable from "./_components/overview-table";
import RoutingCard from "./_components/routing-card";

const SUBSCRIPTION_CATALOG = PROVIDER_CATALOG.filter((spec) => isSignInKind(spec.kind));

export default function SubscriptionsPage() {
  const t = useTranslations("Subscriptions");
  const tProviders = useTranslations("Providers");
  const tCommon = useTranslations("Common");
  const tError = useTranslations("Error");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState<ProviderView[]>([]);
  const [limits, setLimits] = useState<Record<string, AccountLimits>>({});
  const [refreshingId, setRefreshingId] = useState("");
  const [kind, setKind] = useState<(typeof PROVIDER_CATALOG)[number] | null>(null);
  const [edit, setEdit] = useState<ProviderView | null>(null);
  const [discover, setDiscover] = useState<ProviderView | null>(null);
  const [models, setModels] = useState<ImportCandidate[] | null>(null);
  const [dialogKey, setDialogKey] = useState(0);
  const [, startDiscover] = useTransition();
  const [refreshingAll, startRefreshAll] = useTransition();
  const [, startRefreshOne] = useTransition();
  const formState = useOverlayState();
  const discoverState = useOverlayState();

  function storeLimits(items: AccountLimits[]) {
    setLimits((cur) => ({ ...cur, ...Object.fromEntries(items.map((item) => [item.id, item])) }));
  }

  useEffect(() => {
    let active = true;
    loadProvidersAction().then((res) => {
      if (!active) return;
      if (!isActionFail(res)) setConnected(res.connected.filter((row) => isSignInKind(row.kind)));
      setLoading(false);
    });
    loadSubscriptionLimitsAction().then((res) => {
      if (active && !isActionFail(res)) storeLimits(res.items);
    });
    return () => {
      active = false;
    };
  }, []);

  function refreshAll() {
    startRefreshAll(async () => {
      const result = await loadSubscriptionLimitsAction({ refresh: true });
      if (isActionFail(result)) {
        toast.danger(tError("code", { code: result.error }));
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
        isActionFail(result)
          ? { id, limits: null, error: result.error }
          : { id, limits: result.limits, error: "" },
      ]);
    });
  }

  function replaceProvider(provider: ProviderView) {
    setConnected((cur) => cur.map((row) => (row.id === provider.id ? provider : row)));
  }

  function openForm(spec: (typeof PROVIDER_CATALOG)[number] | null, row: ProviderView | null) {
    setKind(spec);
    setEdit(row);
    setDialogKey((n) => n + 1);
    formState.open();
  }

  function openImport(row: ProviderView) {
    setDiscover(row);
    setModels(null);
    setDialogKey((n) => n + 1);
    discoverState.open();
    startDiscover(async () => {
      const result = await discoverProviderAction(row.id);
      if (isActionFail(result)) {
        setModels([]);
        toast.danger(tError("code", { code: result.error }));
        return;
      }
      replaceProvider(result.provider);
      setModels(result.models);
    });
  }

  if (loading) {
    return (
      <output
        aria-live="polite"
        aria-label={tCommon("loading")}
        className="flex min-h-[40vh] items-center justify-center text-accent"
      >
        <Spinner color="current" size="lg" />
      </output>
    );
  }

  const states = connected.map((row) => accountState(row, limits[row.id], reportsLimits(row.kind)));
  const available = states.filter((state) => state === "available" || state === "connected").length;
  const paused = states.filter((state) => state === "paused").length;
  const limited = states.filter((state) => state === "limited").length;
  const recoveries = connected
    .map((row) => recoveryAt(limits[row.id], now.getTime()))
    .filter((time): time is number => time !== null);
  const nextRecovery = recoveries.length ? Math.min(...recoveries) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <Button
            variant="secondary"
            aria-label={t("refreshAll")}
            isPending={refreshingAll}
            isDisabled={connected.length === 0}
            onPress={refreshAll}
          >
            {({ isPending }) => (
              <>
                {isPending ? <Spinner color="current" size="sm" /> : <RefreshCw size={14} aria-hidden />}
                {t("refreshAll")}
              </>
            )}
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard label={t("stats.accounts")} value={format.number(connected.length)} />
        <StatCard label={t("stats.available")} value={format.number(available)} />
        <StatCard label={t("stats.limited")} value={format.number(limited)} />
        <StatCard label={t("stats.paused")} value={format.number(paused)} />
        <StatCard
          label={t("stats.nextRecovery")}
          value={nextRecovery ? format.relativeTime(new Date(nextRecovery), now) : t("stats.none")}
        />
      </div>

      {connected.length > 0 ? (
        <OverviewTable
          rows={connected}
          limits={limits}
          reports={reportsLimits}
          onToggled={replaceProvider}
        />
      ) : null}

      {SUBSCRIPTION_CATALOG.map((spec) => {
        const items = connected.filter((row) => row.kind === spec.kind);
        return (
          <section key={spec.kind} className="space-y-4">
            <Separator />
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-semibold tracking-tight">
                    {tProviders("kindName", { kind: spec.kind })}
                  </h2>
                  <Chip size="sm" variant="soft">
                    {tProviders("connectedCount", { count: items.length })}
                  </Chip>
                </div>
                <p className="text-sm text-muted">{tProviders("kindDescription", { kind: spec.kind })}</p>
              </div>
              <Button
                size="sm"
                variant={items.length ? "secondary" : undefined}
                aria-label={tProviders("formTitle", {
                  mode: "connect",
                  name: tProviders("kindName", { kind: spec.kind }),
                })}
                onPress={() => openForm(spec, null)}
              >
                <Plus size={14} aria-hidden />
                {t("addAccount")}
              </Button>
            </div>
            {items.length > 0 ? (
              <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
                {items.map((row) => (
                  <AccountCard
                    key={row.id}
                    row={row}
                    reports={reportsLimits(row.kind)}
                    entry={limits[row.id]}
                    refreshing={refreshingId === row.id}
                    onRefresh={refreshOne}
                    onEdit={(provider) => openForm(spec, provider)}
                    onImport={openImport}
                    onToggled={replaceProvider}
                    onDeleted={(id) => setConnected((cur) => cur.filter((c) => c.id !== id))}
                  />
                ))}
              </div>
            ) : (
              <Card variant="secondary">
                <Card.Content>
                  <p className="text-sm text-muted">{t("noAccounts")}</p>
                </Card.Content>
              </Card>
            )}
          </section>
        );
      })}

      <Separator />
      <RoutingCard />

      <ProviderDialog
        key={`form-${dialogKey}`}
        state={formState}
        spec={kind}
        editing={edit}
        onSaved={(provider) => {
          setConnected((cur) =>
            cur.some((row) => row.id === provider.id)
              ? cur.map((row) => (row.id === provider.id ? provider : row))
              : [provider, ...cur],
          );
          if (reportsLimits(provider.kind)) refreshOne(provider.id);
        }}
      />

      <ImportModelsDialog
        key={`import-${dialogKey}`}
        state={discoverState}
        provider={discover}
        models={models}
        onImported={replaceProvider}
      />
    </div>
  );
}
