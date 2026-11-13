"use client";

import { useEffect, useRef, useState } from "react";
import { useActionData } from "@/lib/hooks/use-action-data";
import { useLiveConnected } from "@/lib/hooks/use-live";
import { isActionFail, settleAction } from "@/lib/http/action-result";
import { singleFlight } from "@/lib/utils/single-flight";
import type { SubscriptionKeyUsage } from "@/types/providers";
import { loadSubscriptionKeyUsageAction } from "../_action";

const REFRESH_GAP_MS = 10_000;
const FALLBACK_POLL_MS = 30_000;

async function withoutKeyUsage(): Promise<SubscriptionKeyUsage> {
  return { at: 0, accounts: [], keys: {} };
}

export type KeyUsageFeed = ReturnType<typeof useLiveKeyUsage>;

export function useLiveKeyUsage(trigger: string, enabled: boolean) {
  const usage = useActionData<SubscriptionKeyUsage>(enabled ? loadSubscriptionKeyUsageAction : withoutKeyUsage);
  const { setData } = usage;
  const live = useLiveConnected();
  const seen = useRef(trigger);
  const lastRun = useRef(0);
  const [reloadShares] = useState(() =>
    singleFlight(async () => {
      const result = await settleAction(loadSubscriptionKeyUsageAction);
      if (!isActionFail(result)) setData(result);
    }),
  );

  useEffect(() => {
    if (!enabled || seen.current === trigger) return;
    seen.current = trigger;
    const wait = Math.max(0, lastRun.current + REFRESH_GAP_MS - Date.now());
    const timer = setTimeout(() => {
      lastRun.current = Date.now();
      reloadShares();
    }, wait);
    return () => clearTimeout(timer);
  }, [enabled, trigger, reloadShares]);

  useEffect(() => {
    if (!enabled || live) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") reloadShares();
    }, FALLBACK_POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, live, reloadShares]);

  return { usage, live };
}
