import { useEffect, useMemo, useRef, useState } from "react";
import { liveKeyUsageOf, liveRowsOf, liveRunningOf, logLiveUrl } from "@/lib/gateway/request-logs/log-live";
import { LIVE_STALE_MS, LIVE_WATCHDOG_MS } from "@/lib/updates/build-change";
import { parseJsonOrNull } from "@/lib/utils/json";
import type { LiveKeyUsage, LiveLogRows, LogFilterValues, RunningRequest } from "@/types/logs";

export type LogStream = {
  connected: boolean;
  running: RunningRequest[];
  key: LiveKeyUsage | null;
  version: number;
};

type StreamState = LogStream & { base: string | null };

const NO_RUNNING: RunningRequest[] = [];

function idle(base: string | null): StreamState {
  return { base, connected: false, running: NO_RUNNING, key: null, version: 0 };
}

function laterOf(current: string | null, next: string | null): string | null {
  if (!next) return current;
  if (!current) return next;
  return Date.parse(next) > Date.parse(current) ? next : current;
}

function withSince(base: string, since: string | null): string {
  if (!since) return base;
  return `${base}${base.includes("?") ? "&" : "?"}since=${encodeURIComponent(since)}`;
}

export function useLogStream(
  filters: LogFilterValues | null,
  since: string | null,
  onRows: (batch: LiveLogRows) => void,
): LogStream {
  const filterKey = filters ? JSON.stringify(filters) : null;
  const base = useMemo(() => (filterKey ? logLiveUrl(JSON.parse(filterKey) as LogFilterValues, null) : null), [filterKey]);
  const [state, setState] = useState<StreamState>(() => idle(base));
  const rowsListener = useRef(onRows);
  const sinceRef = useRef(since);

  useEffect(() => {
    rowsListener.current = onRows;
    sinceRef.current = laterOf(sinceRef.current, since);
  });

  useEffect(() => {
    if (!base || typeof EventSource === "undefined") return;
    let source: EventSource | null = null;
    let lastEventAt = 0;
    let retryAt = 0;

    const update = (patch: (current: StreamState) => Partial<StreamState> | null) =>
      setState((previous) => {
        const current = previous.base === base ? previous : idle(base);
        const next = patch(current);
        return next ? { ...current, ...next } : current;
      });

    const markOpen = () => {
      lastEventAt = Date.now();
      update((current) => (current.connected ? null : { connected: true }));
    };

    const markLost = () => {
      retryAt = Date.now() + LIVE_WATCHDOG_MS;
      update((current) =>
        current.connected || current.running.length ? { connected: false, running: NO_RUNNING } : null,
      );
    };

    const close = () => {
      source?.close();
      source = null;
    };

    const connect = () => {
      close();
      lastEventAt = Date.now();
      const next = new EventSource(withSince(base, sinceRef.current));
      source = next;
      next.addEventListener("rows", (event) => {
        markOpen();
        const batch = liveRowsOf(parseJsonOrNull(event.data));
        if (!batch) return;
        for (const row of batch.rows) sinceRef.current = laterOf(sinceRef.current, row.createdAt);
        rowsListener.current(batch);
        update((current) => ({ version: current.version + 1 }));
      });
      next.addEventListener("running", (event) => {
        markOpen();
        const running = liveRunningOf(parseJsonOrNull(event.data));
        if (running) update(() => ({ running: running.items.length ? running.items : NO_RUNNING }));
      });
      next.addEventListener("key", (event) => {
        markOpen();
        const key = liveKeyUsageOf(parseJsonOrNull(event.data));
        if (key) update(() => ({ key }));
      });
      next.addEventListener("ping", markOpen);
      const end = () => {
        next.close();
        if (source === next) markLost();
      };
      next.addEventListener("restart", end);
      next.addEventListener("expired", end);
      next.addEventListener("error", () => {
        if (source === next) markLost();
      });
    };

    const hidden = () => document.visibilityState === "hidden";

    const watchdog = () => {
      if (hidden()) return;
      const now = Date.now();
      if (!source || source.readyState === EventSource.CLOSED) {
        if (now >= retryAt) connect();
        return;
      }
      if (now - lastEventAt > LIVE_STALE_MS) {
        markLost();
        connect();
      }
    };

    const visibility = () => {
      if (!hidden()) {
        if (!source || source.readyState === EventSource.CLOSED) connect();
        return;
      }
      close();
      markLost();
    };

    if (!hidden()) connect();
    const timer = setInterval(watchdog, LIVE_WATCHDOG_MS);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
      close();
    };
  }, [base]);

  return state.base === base ? state : idle(base);
}
