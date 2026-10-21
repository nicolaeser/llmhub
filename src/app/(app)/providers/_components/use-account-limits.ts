"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useErrorToast } from "@/components/console/use-error-toast";
import { reportsLimits } from "@/lib/gateway/upstreams/provider-kinds";
import { useActionData } from "@/lib/hooks/use-action-data";
import { useLiveConnected, useLiveLimits } from "@/lib/hooks/use-live";
import { isActionFail } from "@/lib/http/action-result";
import { withLimitItems } from "@/lib/updates/live-events";
import type { LimitSnapshot, LimitSnapshotList, ProviderView } from "@/types/providers";
import { loadProviderLimitsAction, loadSubscriptionLimitsAction } from "../_action";

const FALLBACK_POLL_MS = 60_000;
const RECONCILE_DELAY_MS = 6_000;

export function useAccountLimits(rows: ProviderView[] | null, reloadRows: () => void) {
  const showError = useErrorToast();
  const seed = useActionData<LimitSnapshotList>(() => loadSubscriptionLimitsAction());
  const { data: seedList, setData: setSeed, reload: reloadSeed } = seed;
  const { items, removed } = useLiveLimits(seedList);
  const live = useLiveConnected();
  const reconciled = useRef("");
  const [refreshing, setRefreshing] = useState<string[]>([]);
  const [refreshingAll, startRefreshAll] = useTransition();
  const [, startRefreshOne] = useTransition();

  function storeItems(list: LimitSnapshot[]) {
    if (seedList) setSeed((current) => withLimitItems(current, list));
    else reloadSeed();
  }

  function storeList(list: LimitSnapshotList) {
    if (seedList) setSeed(list);
    else reloadSeed();
  }

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

  const listed = new Set(rows?.map((row) => row.id));
  const staleKey = rows
    ? [...Object.keys(items).filter((id) => !listed.has(id)), ...removed.filter((id) => listed.has(id))].sort().join(",")
    : "";

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
    setRefreshing((current) => [...current, id]);
    startRefreshOne(async () => {
      const result = await loadProviderLimitsAction({ id, refresh: true });
      setRefreshing((current) => current.filter((item) => item !== id));
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      storeItem(result.item);
    });
  }

  function refreshAdded(providers: ProviderView[]) {
    const fresh = providers.filter((provider) => reportsLimits(provider.kind) && provider.enabled);
    if (!fresh.length) return;
    startRefreshAll(async () => {
      const results = await Promise.all(
        fresh.map((provider) => loadProviderLimitsAction({ id: provider.id, refresh: true })),
      );
      storeItems(results.flatMap((result) => (isActionFail(result) || !result.item ? [] : [result.item])));
    });
  }

  return {
    seed,
    items,
    checking: seedList === null,
    refreshing,
    refreshingAll,
    refreshAll,
    refreshOne,
    refreshAdded,
    storeItem,
  };
}

export type AccountLimitsState = ReturnType<typeof useAccountLimits>;
