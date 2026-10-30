"use client";

import { useEffect, useRef } from "react";
import { useActionData } from "@/lib/hooks/use-action-data";
import { useLiveConnected } from "@/lib/hooks/use-live";
import { isActionFail } from "@/lib/http/action-result";
import type { SubscriptionKeyUsage } from "@/types/providers";
import { loadSubscriptionKeyUsageAction } from "../_action";

const REFRESH_GAP_MS = 10_000;
const FALLBACK_POLL_MS = 30_000;

export function useLiveKeyUsage(trigger: string) {
  const usage = useActionData<SubscriptionKeyUsage>(loadSubscriptionKeyUsageAction);
  const { setData } = usage;
  const live = useLiveConnected();
  const seen = useRef(trigger);
  const lastRun = useRef(0);
  const ticket = useRef(0);

  useEffect(() => {
    if (seen.current === trigger) return;
    seen.current = trigger;
    const wait = Math.max(0, lastRun.current + REFRESH_GAP_MS - Date.now());
    const timer = setTimeout(() => {
      lastRun.current = Date.now();
      const current = ++ticket.current;
      loadSubscriptionKeyUsageAction().then((res) => {
        if (current === ticket.current && !isActionFail(res)) setData(res);
      });
    }, wait);
    return () => clearTimeout(timer);
  }, [trigger, setData]);

  useEffect(() => {
    if (live) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const current = ++ticket.current;
      loadSubscriptionKeyUsageAction().then((res) => {
        if (current === ticket.current && !isActionFail(res)) setData(res);
      });
    }, FALLBACK_POLL_MS);
    return () => clearInterval(timer);
  }, [live, setData]);

  return { usage, live };
}
