import { useEffect, useRef } from "react";
import { useLiveConnected, useLiveRequests } from "@/lib/hooks/use-live";

const LIVE_RELOAD_GAP_MS = 10_000;
const POLL_INTERVAL_MS = 15_000;

export function useLiveReload(enabled: boolean, refresh: () => void) {
  const connected = useLiveConnected();
  const requestId = useLiveRequests()?.requestId ?? null;
  const seen = useRef<string | null | undefined>(undefined);
  const refreshedAt = useRef(0);

  useEffect(() => {
    if (!enabled || !connected) return;
    if (seen.current === undefined) {
      seen.current = requestId;
      return;
    }
    if (!requestId || seen.current === requestId) return;
    const timer = setTimeout(
      () => {
        seen.current = requestId;
        refreshedAt.current = Date.now();
        refresh();
      },
      Math.max(0, refreshedAt.current + LIVE_RELOAD_GAP_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [enabled, connected, requestId, refresh]);

  useEffect(() => {
    if (!enabled || connected) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const schedule = () => {
      clearInterval(timer);
      timer = document.visibilityState === "visible" ? setInterval(refresh, POLL_INTERVAL_MS) : undefined;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
      schedule();
    };
    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, connected, refresh]);
}
