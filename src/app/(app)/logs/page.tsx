"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Skeleton, Tabs, useOverlayState } from "@heroui/react";
import { Activity, ArrowUp, Download } from "lucide-react";
import { useTranslations } from "next-intl";
import PageHeader from "@/components/console/page-header";
import PageStatus, { LoadError, SectionLoading } from "@/components/console/page-status";
import { useErrorToast } from "@/components/console/use-error-toast";
import { useActionData } from "@/lib/hooks/use-action-data";
import { consoleTimeZone } from "@/lib/hooks/use-console-time-zone";
import { useLiveConnected, useLiveRequests } from "@/lib/hooks/use-live";
import { setSearchParams, useSearchString } from "@/lib/hooks/use-search-param";
import { logFilterParams, logFiltersFromSearch, zonedLogFilters } from "@/lib/gateway/request-logs/request-log-query";
import { isActionFail } from "@/lib/http/action-result";
import type {
  LogKind,
  LogFilterValues,
  LogOptions,
  LogSessionRef,
  NewLogsCount,
  RequestLogDetail,
  RequestLogRow,
} from "@/types/logs";
import { countNewLogsAction, loadLogDetailAction, loadLogOptionsAction, loadLogsAction } from "./_action";
import LogDetailDialog from "./_components/log-detail-dialog";
import LogFilters, { NO_FILTERS } from "./_components/log-filters";
import LogTable from "./_components/log-table";
import SessionList from "./_components/session-list";
import SessionTrace from "./_components/session-trace";

const PAGE_SIZE = 50;
const POLL_INTERVAL_MS = 15_000;
const LIVE_RELOAD_GAP_MS = 10_000;
const NO_OPTIONS: LogOptions = { models: [], keys: [], users: [] };
const LOG_KINDS: readonly LogKind[] = ["requests", "sessions", "spend", "audit"];

function kindOf(search: string): LogKind {
  const requested = new URLSearchParams(search).get("tab");
  return LOG_KINDS.find((kind) => kind === requested) ?? "requests";
}

function traceOf(search: string): LogSessionRef | null {
  const params = new URLSearchParams(search);
  const sessionId = params.get("trace");
  if (!sessionId) return null;
  return { sessionId, keyId: params.get("traceKey") ?? "", userId: params.get("traceUser") ?? "" };
}

function traceParams(ref: LogSessionRef | null) {
  return { trace: ref?.sessionId ?? null, traceKey: ref?.keyId || null, traceUser: ref?.userId || null };
}

function download(href: string) {
  const link = document.createElement("a");
  link.href = href;
  link.click();
}

function queryFilters(filters: LogFilterValues): LogFilterValues {
  return zonedLogFilters(filters, consoleTimeZone());
}

function exportHref(kind: LogKind, format: "csv" | "jsonl", filters: LogFilterValues) {
  const params = new URLSearchParams({ kind, format });
  for (const [key, value] of Object.entries(logFilterParams(queryFilters(filters)))) {
    if (value !== null) params.set(key, value);
  }
  return `/internal-api/logs/export?${params.toString()}`;
}

export default function LogsPage() {
  const t = useTranslations("Logs");
  const showError = useErrorToast();
  const search = useSearchString();
  const filters = useMemo(() => logFiltersFromSearch(search ?? ""), [search]);
  const filterKey = JSON.stringify(logFilterParams(filters));
  const requestedKind = kindOf(search ?? "");
  const trace = useMemo(() => traceOf(search ?? ""), [search]);
  const [options, setOptions] = useState<LogOptions | null>(null);
  const [detail, setDetail] = useState<RequestLogDetail | null>(null);
  const [newestSeen, setNewestSeen] = useState<string | null>(null);
  const [fresh, setFresh] = useState<NewLogsCount | null>(null);
  const detailState = useOverlayState();
  const logsState = useActionData(
    () =>
      loadLogsAction({ page: 1, pageSize: PAGE_SIZE, filters: queryFilters(logFiltersFromSearch(window.location.search)) }),
    (data) => {
      if (data.page === 1) setNewestSeen(data.requests[0]?.createdAt ?? null);
    },
  );
  const { data: logs, setData: setLogs, pending } = logsState;
  const page = logs?.page ?? 1;
  const connected = useLiveConnected();
  const live = useLiveRequests();
  const liveKey = live ? `${live.requestId ?? ""}|${live.auditId ?? ""}` : "";
  const liveRequestId = live?.requestId ?? null;
  const newestId = page === 1 ? (logs?.requests[0]?.id ?? null) : null;
  const handledKey = useRef<string | null>(null);
  const reloadedAt = useRef(0);

  useEffect(() => {
    loadLogOptionsAction().then(
      (res) => setOptions(isActionFail(res) ? NO_OPTIONS : res),
      () => setOptions(NO_OPTIONS),
    );
  }, []);

  function load(nextPage: number, nextFilters: LogFilterValues) {
    logsState.reloadWith(() => loadLogsAction({ page: nextPage, pageSize: PAGE_SIZE, filters: queryFilters(nextFilters) }));
  }

  function openSession(ref: LogSessionRef) {
    setSearchParams({ tab: "sessions", ...traceParams(ref) });
  }

  function showSessionRequests(ref: LogSessionRef) {
    const next = { ...filters, session: ref.sessionId, keyId: ref.keyId, userId: ref.userId };
    setSearchParams({ ...logFilterParams(next), tab: null, ...traceParams(null) });
    load(1, next);
  }

  function exportSession(ref: LogSessionRef) {
    download(exportHref("requests", "csv", { ...NO_FILTERS, session: ref.sessionId, keyId: ref.keyId, userId: ref.userId }));
  }

  function openDetail(row: RequestLogRow) {
    setDetail(null);
    detailState.open();
    loadLogDetailAction(row.id).then((res) => {
      if (isActionFail(res)) {
        detailState.close();
        showError(res.error);
        return;
      }
      setDetail(res);
    });
  }

  useEffect(() => {
    if (!connected || !liveKey || handledKey.current === liveKey) return;
    if (handledKey.current === null && liveRequestId === newestId) {
      handledKey.current = liveKey;
      return;
    }
    let active = true;
    const since = newestSeen;
    const timer = setTimeout(
      () => {
        handledKey.current = liveKey;
        reloadedAt.current = Date.now();
        if (page === 1) {
          loadLogsAction({ page: 1, pageSize: PAGE_SIZE, filters: queryFilters(filters) }).then((res) => {
            if (!active || isActionFail(res)) return;
            setLogs(res);
            setNewestSeen(res.requests[0]?.createdAt ?? null);
          });
          return;
        }
        if (!since) return;
        countNewLogsAction({ since, filters: queryFilters(filters) }).then((res) => {
          if (active && !isActionFail(res)) setFresh({ since, ...res });
        });
      },
      Math.max(0, reloadedAt.current + LIVE_RELOAD_GAP_MS - Date.now()),
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [connected, liveKey, liveRequestId, newestId, newestSeen, page, filters, setLogs]);

  useEffect(() => {
    if (page !== 1 || connected) return;
    let active = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const tick = () => {
      loadLogsAction({ page: 1, pageSize: PAGE_SIZE, filters: queryFilters(filters) }).then((res) => {
        if (!active || isActionFail(res)) return;
        setLogs(res);
        setNewestSeen(res.requests[0]?.createdAt ?? null);
      });
    };
    const schedule = () => {
      clearInterval(timer);
      timer = document.visibilityState === "visible" ? setInterval(tick, POLL_INTERVAL_MS) : undefined;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") tick();
      schedule();
    };
    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [page, filters, connected, setLogs]);

  if (!logs || !options) {
    return (
      <PageStatus icon={Activity} title={t("title")} subtitle={t("subtitle")} state={logsState} filters={10} tabs layout="rows" />
    );
  }

  const kind: LogKind = requestedKind === "audit" && !logs.canAudit ? "requests" : requestedKind;
  const total =
    kind === "requests" ? logs.requestTotal : kind === "spend" ? logs.spendTotal : logs.auditTotal;
  const newer = page > 1 && fresh && fresh.since === newestSeen && fresh.count > 0 ? fresh : null;

  return (
    <div>
      <PageHeader
        icon={Activity}
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" onPress={() => download(exportHref(kind, "csv", filters))}>
              <Download size={14} aria-hidden />
              {t("exportCsv")}
            </Button>
            <Button variant="secondary" onPress={() => download(exportHref(kind, "jsonl", filters))}>
              <Download size={14} aria-hidden />
              {t("exportJsonl")}
            </Button>
          </div>
        }
      />
      <LogFilters
        key={`filters:${filterKey}`}
        pending={pending}
        options={options}
        initial={filters}
        onApply={(next) => {
          setSearchParams(logFilterParams(next));
          load(1, next);
        }}
      />
      <Tabs
        selectedKey={kind}
        onSelectionChange={(key) => {
          const next = String(key);
          setSearchParams({ tab: next === "requests" ? null : next, ...traceParams(null) });
        }}
        aria-label={t("title")}
        className="mb-4 max-w-full"
      >
        <Tabs.List className="w-full flex-wrap" aria-label={t("title")}>
          <Tabs.Tab id="requests" className="w-auto whitespace-nowrap">
            {t("tabs.requests")}
          </Tabs.Tab>
          <Tabs.Tab id="sessions" className="w-auto whitespace-nowrap">
            {t("tabs.sessions")}
          </Tabs.Tab>
          <Tabs.Tab id="spend" className="w-auto whitespace-nowrap">
            {t("tabs.spend")}
          </Tabs.Tab>
          {logs.canAudit ? (
            <Tabs.Tab id="audit" className="w-auto whitespace-nowrap">
              {t("tabs.audit")}
            </Tabs.Tab>
          ) : null}
        </Tabs.List>
      </Tabs>

      <LoadError state={logsState} className="mb-4" />

      {kind === "sessions" ? (
        trace ? (
          <SessionTrace
            key={`trace:${JSON.stringify(trace)}`}
            sessionRef={trace}
            onBack={() => setSearchParams(traceParams(null))}
            onOpenRequest={openDetail}
            onShowRequests={showSessionRequests}
            onExport={exportSession}
          />
        ) : (
          <SessionList key={`sessions:${filterKey}`} filters={filters} onOpen={openSession} />
        )
      ) : (
        <>
        {newer ? (
          <div className="mb-4 flex flex-wrap items-center gap-2" aria-live="polite">
            <Button size="sm" variant="secondary" isPending={pending} onPress={() => load(1, filters)}>
              <ArrowUp size={14} aria-hidden />
              {t("newRequests", { count: newer.count, capped: String(newer.capped) })}
            </Button>
          </div>
        ) : null}

        {pending ? <SectionLoading shape="table" rows={8} /> : <LogTable kind={kind} logs={logs} onOpen={openDetail} />}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          {pending ? (
            <Skeleton className="h-3.5 w-40 rounded-lg" />
          ) : (
            <p className="text-sm text-muted">{t("pageStatus", { page, total, pageSize: logs.pageSize })}</p>
          )}
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              isDisabled={page <= 1}
              isPending={pending}
              onPress={() => load(page - 1, filters)}
            >
              {t("prev")}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              isDisabled={page * logs.pageSize >= total}
              isPending={pending}
              onPress={() => load(page + 1, filters)}
            >
              {t("next")}
            </Button>
          </div>
        </div>
        </>
      )}

      <LogDetailDialog
        state={detailState}
        detail={detail}
        onExport={(format) => {
          if (detail) download(`/internal-api/logs/${encodeURIComponent(detail.id)}/export?format=${format}`);
        }}
        onOpenSession={(opened) => {
          detailState.close();
          openSession({ sessionId: opened.sessionId, keyId: opened.keyId, userId: opened.userId });
        }}
      />
    </div>
  );
}
