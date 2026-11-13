"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "@heroui/react";
import { useTranslations } from "next-intl";
import { useErrorToast } from "@/components/console/use-error-toast";
import { reportsLimits } from "@/lib/gateway/upstreams/provider-kinds";
import { useActionData } from "@/lib/hooks/use-action-data";
import { useLiveConnected, useLiveLimits, useLiveTopic } from "@/lib/hooks/use-live";
import { isActionFail, settleAction } from "@/lib/http/action-result";
import { withLimitItems, withLimitList } from "@/lib/updates/live-events";
import { singleFlight } from "@/lib/utils/single-flight";
import type { LimitRefreshOutcomes, LimitSnapshot, LimitSnapshotList, ProviderView } from "@/types/providers";
import { loadProviderLimitsAction, loadSubscriptionLimitsAction } from "../_action";
import {
  awaitedRefreshes,
  finishedRefresh,
  refreshNotice,
  startedRefresh,
  stillAwaited,
  type AwaitedRefreshes,
} from "./account-refreshes";

const FALLBACK_POLL_MS = 60_000;
const AWAITED_POLL_MS = 5_000;
const AWAITED_LIMIT_MS = 75_000;
const RECONCILE_DELAY_MS = 6_000;

export function useAccountLimits(rows: ProviderView[] | null, reloadRows: () => void) {
  const t = useTranslations("Subscriptions");
  const showError = useErrorToast();
  const seed = useActionData<LimitSnapshotList>(() => loadSubscriptionLimitsAction());
  const { data: seedList, setData: setSeed, reload: reloadSeed } = seed;
  const { items, removed } = useLiveLimits(seedList);
  const streamed = useLiveTopic("limits") !== null;
  const live = useLiveConnected();
  const reconciled = useRef("");
  const seeded = useRef(false);
  const [refreshing, setRefreshing] = useState<string[]>([]);
  const [sweeps, setSweeps] = useState(0);
  const [awaited, setAwaited] = useState<AwaitedRefreshes>({});
  const awaiting = stillAwaited(awaited, items);
  const awaitingKey = awaiting.join(",");
  const pollMs = awaiting.length > 0 ? AWAITED_POLL_MS : FALLBACK_POLL_MS;

  useEffect(() => {
    seeded.current = seedList !== null;
  }, [seedList]);

  function storeItems(list: LimitSnapshot[]) {
    if (!list.length) return;
    if (seeded.current) setSeed((current) => withLimitItems(current, list));
    else reloadSeed();
  }

  function storeList(list: LimitSnapshotList) {
    if (seeded.current) setSeed((current) => withLimitList(current, list));
    else reloadSeed();
  }

  useEffect(() => {
    if (live) return;
    const reread = singleFlight(async () => {
      if (!seeded.current) {
        reloadSeed();
        return;
      }
      const result = await settleAction(() => loadSubscriptionLimitsAction());
      if (!isActionFail(result)) setSeed((current) => withLimitList(current, result));
    });
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") reread();
    }, pollMs);
    return () => clearInterval(timer);
  }, [live, pollMs, setSeed, reloadSeed]);

  useEffect(() => {
    if (!awaitingKey) return;
    const timer = setTimeout(() => setAwaited({}), AWAITED_LIMIT_MS);
    return () => clearTimeout(timer);
  }, [awaitingKey]);

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

  function noteOutcomes(outcomes: LimitRefreshOutcomes | undefined, list: LimitSnapshot[]) {
    const pending = awaitedRefreshes(outcomes, list);
    if (Object.keys(pending).length > 0) setAwaited((current) => ({ ...current, ...pending }));
    const notice = refreshNotice(outcomes);
    if (notice) toast(t("refreshNotice", notice).trim(), { variant: notice.failed > 0 ? "warning" : "default" });
  }

  async function runRefreshAll() {
    setSweeps((count) => count + 1);
    const result = await settleAction(() => loadSubscriptionLimitsAction({ refresh: true }));
    setSweeps((count) => count - 1);
    if (isActionFail(result)) {
      showError(result.error);
      return;
    }
    storeList(result);
    noteOutcomes(result.refresh, result.items);
  }

  async function runRefreshOne(id: string) {
    setRefreshing((current) => startedRefresh(current, id));
    const result = await settleAction(() => loadProviderLimitsAction({ id, refresh: true }));
    setRefreshing((current) => finishedRefresh(current, id));
    if (isActionFail(result)) {
      showError(result.error);
      return;
    }
    storeItem(result.item);
    noteOutcomes(result.refresh ? { [id]: result.refresh } : undefined, result.item ? [result.item] : []);
  }

  async function runRefreshAdded(fresh: ProviderView[]) {
    setSweeps((count) => count + 1);
    for (const provider of fresh) {
      const result = await settleAction(() => loadProviderLimitsAction({ id: provider.id, refresh: true }));
      if (isActionFail(result)) continue;
      storeItem(result.item);
      const pending = awaitedRefreshes(
        result.refresh ? { [provider.id]: result.refresh } : undefined,
        result.item ? [result.item] : [],
      );
      if (Object.keys(pending).length > 0) setAwaited((current) => ({ ...current, ...pending }));
    }
    setSweeps((count) => count - 1);
  }

  function refreshAll() {
    void runRefreshAll();
  }

  function refreshOne(id: string) {
    void runRefreshOne(id);
  }

  function refreshAdded(providers: ProviderView[]) {
    const fresh = providers.filter((provider) => reportsLimits(provider.kind) && provider.enabled);
    if (fresh.length) void runRefreshAdded(fresh);
  }

  return {
    seed,
    items,
    checking: seedList === null && !streamed,
    refreshing: [...refreshing, ...awaiting],
    refreshingAll: sweeps > 0,
    refreshAll,
    refreshOne,
    refreshAdded,
    storeItem,
  };
}

export type AccountLimitsState = ReturnType<typeof useAccountLimits>;
