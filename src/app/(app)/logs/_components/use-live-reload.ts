import { useEffect, useRef } from "react";
import type { LogStream } from "./use-log-stream";

const LIVE_RELOAD_GAP_MS = 1_000;
const POLL_INTERVAL_MS = 15_000;

export function useLiveReload(
  enabled: boolean,
  stream: Pick<LogStream, "connected" | "version">,
  refresh: () => void,
  poll = enabled,
) {
  const { connected, version } = stream;
  const seen = useRef(version);
  const refreshedAt = useRef(0);

  useEffect(() => {
    if (!enabled || !connected || seen.current === version) return;
    const timer = setTimeout(
      () => {
        seen.current = version;
        refreshedAt.current = Date.now();
        refresh();
      },
      Math.max(0, refreshedAt.current + LIVE_RELOAD_GAP_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [enabled, connected, version, refresh]);

  useEffect(() => {
    if (!enabled || !poll || connected) return;
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
  }, [enabled, poll, connected, refresh]);
}
