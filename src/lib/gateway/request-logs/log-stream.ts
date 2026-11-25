import "server-only";
import prisma from "@/lib/db/prisma";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { spendScopeKey } from "@/lib/auth/scope";
import { requestLogLabels, requestLogRow } from "@/lib/gateway/request-logs/request-log-detail";
import { requestLogWhere } from "@/lib/gateway/request-logs/request-log-query";
import { activityMatches, runningMatches } from "@/lib/gateway/request-logs/log-live";
import { runningEntries, watchRequestActivity, type RunningEntry } from "@/lib/gateway/request-logs/request-activity";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { keyBudgetUsage } from "@/lib/tenancy/budgets";
import { holdLiveStream } from "@/lib/updates/live";
import { LIVE_ACCESS_RECHECK_MS, LIVE_HEARTBEAT_MS, LIVE_RETRY_MS, sseEvent, type LiveAccess } from "@/lib/updates/live-stream";
import type { KeyBudgetUsage, LogFilterValues, RequestActivity, RequestLogRow, RunningRequest } from "@/types/logs";
import type { SpendScope } from "@/types/structure";

export const LOG_STREAM_POLL_MS = 5_000;
export const LOG_STREAM_NOTIFY_MS = 150;
export const LOG_STREAM_OVERLAP_MS = 5_000;
export const LOG_STREAM_ROW_LIMIT = 100;
const KEY_REFRESH_MS = 30_000;

export type LogRowBatch = { rows: RequestLogRow[]; newestMs: number | null; full: boolean };

export type LogStreamSources = {
  loadRows(filters: LogFilterValues, scope: SpendScope, afterMs: number): Promise<LogRowBatch>;
  loadKey(scope: SpendScope, keyId: string): Promise<KeyBudgetUsage | null>;
  running(): RunningEntry[];
  watch(listener: (activity: RequestActivity) => void): () => void;
};

async function loadRows(filters: LogFilterValues, scope: SpendScope, afterMs: number): Promise<LogRowBatch> {
  const rows = await prisma.requestLog.findMany({
    where: { AND: [requestLogWhere(filters, scope), { createdAt: { gt: new Date(afterMs) } }] },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: LOG_STREAM_ROW_LIMIT,
    include: { contents: { select: { logId: true }, take: 1 } },
  });
  const names = await requestLogLabels(rows);
  return {
    rows: rows.map((row) => requestLogRow(row, names)),
    newestMs: rows[0]?.createdAt.getTime() ?? null,
    full: rows.length >= LOG_STREAM_ROW_LIMIT,
  };
}

const DEFAULT_SOURCES: LogStreamSources = {
  loadRows,
  loadKey: (scope, keyId) => keyBudgetUsage(scope, keyId),
  running: () => runningEntries(),
  watch: watchRequestActivity,
};

function publicRunning(entry: RunningEntry): RunningRequest {
  return {
    id: entry.id,
    startedAt: entry.startedAt,
    model: entry.model,
    endpoint: entry.endpoint,
    stream: entry.stream,
    keyId: entry.keyId,
    agent: entry.agent,
  };
}

function closeQuietly(controller: ReadableStreamDefaultController<Uint8Array>): boolean {
  try {
    controller.close();
    return true;
  } catch {
    return false;
  }
}

export function logStream(input: {
  sessionId: string;
  scope: SpendScope;
  filters: LogFilterValues;
  sinceMs: number;
  signal: AbortSignal;
  checkAccess: (sessionId: string, now: number) => Promise<LiveAccess | null>;
  sources?: Partial<LogStreamSources>;
  pollMs?: number;
  heartbeatMs?: number;
  accessCheckMs?: number;
  notifyMs?: number;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const sources = { ...DEFAULT_SOURCES, ...input.sources };
  const { filters, scope } = input;
  const scopeKey = spendScopeKey(scope);
  const sent = new Map<string, number>();
  let cursorMs = input.sinceMs;
  let rowsDue = true;
  let runningDue = true;
  let keyDue = Boolean(filters.keyId);
  let keyLoadedAt = 0;
  let lastRunning: string | null = null;
  let lastKey: string | null = null;
  let busy = false;
  let again = false;
  let closed = false;
  let accessCheckedAt = Date.now();
  let notifyTimer: ReturnType<typeof setTimeout> | undefined;
  let poller: ReturnType<typeof setInterval> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unwatch = () => {};
  let release = () => {};
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  function stop(closeStream: boolean) {
    if (closed) return;
    closed = true;
    clearTimeout(notifyTimer);
    clearInterval(poller);
    clearInterval(heartbeat);
    unwatch();
    release();
    input.signal.removeEventListener("abort", onAbort);
    if (closeStream && controllerRef) closeQuietly(controllerRef);
  }

  function onAbort() {
    stop(true);
  }

  function send(event: string, data: string) {
    if (closed || !controllerRef) return;
    try {
      controllerRef.enqueue(encoder.encode(sseEvent(event, data)));
    } catch {
      stop(false);
    }
  }

  async function sendRows(): Promise<boolean> {
    const batch = await sources.loadRows(filters, scope, cursorMs - LOG_STREAM_OVERLAP_MS);
    if (batch.newestMs !== null && batch.newestMs > cursorMs) cursorMs = batch.newestMs;
    const fresh = batch.rows.filter((row) => !sent.has(row.id));
    for (const row of batch.rows) sent.set(row.id, Date.parse(row.createdAt));
    const floor = cursorMs - 2 * LOG_STREAM_OVERLAP_MS;
    for (const [id, at] of sent) if (at < floor) sent.delete(id);
    if (!fresh.length) return false;
    send("rows", JSON.stringify({ rows: fresh, more: batch.full && fresh.length === batch.rows.length }));
    return true;
  }

  function sendRunning() {
    const items = sources
      .running()
      .filter((entry) => runningMatches(filters, scope, entry))
      .sort((a, b) => a.startedMs - b.startedMs)
      .map(publicRunning);
    const json = JSON.stringify(items);
    if (json === lastRunning) return;
    lastRunning = json;
    send("running", JSON.stringify({ at: Date.now(), items }));
  }

  async function sendKey() {
    keyLoadedAt = Date.now();
    const usage = await sources.loadKey(scope, filters.keyId);
    const json = JSON.stringify(usage);
    if (json === lastKey) return;
    lastKey = json;
    send("key", JSON.stringify({ at: keyLoadedAt, usage }));
  }

  async function flush() {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      do {
        again = false;
        const wantRows = rowsDue;
        const wantRunning = runningDue;
        const wantKey = keyDue;
        rowsDue = false;
        runningDue = false;
        keyDue = false;
        const fresh = wantRows ? await sendRows() : false;
        if (closed) return;
        if (wantRunning || fresh) sendRunning();
        if (filters.keyId && (wantKey || fresh)) await sendKey();
      } while (again && !closed);
    } catch (err) {
      logger.warn("logs.live_failed", errorFields(err));
    } finally {
      busy = false;
    }
  }

  function schedule(delayMs: number) {
    if (closed || notifyTimer) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = undefined;
      void flush();
    }, delayMs);
    notifyTimer.unref?.();
  }

  function onActivity(activity: RequestActivity) {
    if (!activityMatches(filters, scope, activity)) return;
    if (activity.kind === "row") rowsDue = true;
    runningDue = true;
    schedule(input.notifyMs ?? LOG_STREAM_NOTIFY_MS);
  }

  async function recheckAccess(now: number) {
    accessCheckedAt = now;
    try {
      const next = await input.checkAccess(input.sessionId, now);
      const allowed =
        next !== null &&
        hasPerm(next.viewer.permissions, PERMISSIONS.SPEND_READ) &&
        spendScopeKey(next.viewer.scope) === scopeKey;
      if (allowed) return;
      send("expired", "{}");
      stop(true);
    } catch (err) {
      logger.warn("logs.live_access_check_failed", errorFields(err));
    }
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      if (input.signal.aborted) {
        stop(true);
        return;
      }
      input.signal.addEventListener("abort", onAbort, { once: true });
      release = holdLiveStream(() => {
        send("restart", "{}");
        stop(true);
      });
      if (closed) return;
      controller.enqueue(encoder.encode(`retry: ${LIVE_RETRY_MS}\n\n`));
      unwatch = sources.watch(onActivity);
      void flush();
      poller = setInterval(() => {
        rowsDue = true;
        runningDue = true;
        if (filters.keyId && Date.now() - keyLoadedAt >= KEY_REFRESH_MS) keyDue = true;
        void flush();
      }, input.pollMs ?? LOG_STREAM_POLL_MS);
      poller.unref?.();
      heartbeat = setInterval(() => {
        const now = Date.now();
        send("ping", String(now));
        if (now - accessCheckedAt >= (input.accessCheckMs ?? LIVE_ACCESS_RECHECK_MS)) void recheckAccess(now);
      }, input.heartbeatMs ?? LIVE_HEARTBEAT_MS);
      heartbeat.unref?.();
    },
    cancel() {
      stop(false);
    },
  });
}
