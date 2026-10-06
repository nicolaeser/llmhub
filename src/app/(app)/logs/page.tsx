"use client";

import { useEffect, useState, useTransition } from "react";
import { Button, Spinner, Tabs, toast, useOverlayState } from "@heroui/react";
import { Download } from "lucide-react";
import { useTranslations } from "next-intl";
import PageHeader from "@/components/console/page-header";
import { isActionFail } from "@/lib/http/action-result";
import type { Kind, LogFilterValues, LogOptions, RequestLogDetail, RequestLogRow } from "@/types/logs";
import { loadLogDetailAction, loadLogOptionsAction, loadLogsAction } from "./_action";
import LogDetailDialog from "./_components/log-detail-dialog";
import LogFilters, { NO_FILTERS } from "./_components/log-filters";
import LogTable, { type LogsPayload } from "./_components/log-table";

const PAGE_SIZE = 50;
const LIVE_INTERVAL_MS = 15_000;
const NO_OPTIONS: LogOptions = { keys: [], users: [] };
const NO_LOGS: LogsPayload = {
  canAudit: false,
  page: 1,
  pageSize: PAGE_SIZE,
  requestTotal: 0,
  spendTotal: 0,
  auditTotal: 0,
  requests: [],
  spend: [],
  audit: [],
};

function download(href: string) {
  const link = document.createElement("a");
  link.href = href;
  link.click();
}

function exportHref(kind: Kind, format: "csv" | "jsonl", filters: LogFilterValues) {
  const params = new URLSearchParams({ kind, format });
  for (const [key, value] of Object.entries(filters)) {
    if (value === true) params.set(key, "1");
    else if (typeof value === "string" && value) params.set(key, value);
  }
  return `/internal-api/logs/export?${params.toString()}`;
}

export default function LogsPage() {
  const t = useTranslations("Logs");
  const tCommon = useTranslations("Common");
  const tError = useTranslations("Error");
  const [kind, setKind] = useState<Kind>("requests");
  const [filters, setFilters] = useState<LogFilterValues>(NO_FILTERS);
  const [logs, setLogs] = useState<LogsPayload>(NO_LOGS);
  const [options, setOptions] = useState<LogOptions>(NO_OPTIONS);
  const [detail, setDetail] = useState<RequestLogDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, start] = useTransition();
  const detailState = useOverlayState();
  const page = logs.page;

  useEffect(() => {
    loadLogsAction({ page: 1, pageSize: PAGE_SIZE }).then((res) => {
      if (!isActionFail(res)) setLogs(res);
      setLoading(false);
    });
    loadLogOptionsAction().then((res) => {
      if (!isActionFail(res)) setOptions(res);
    });
  }, []);

  function load(nextPage: number, nextFilters: LogFilterValues) {
    start(async () => {
      const res = await loadLogsAction({ page: nextPage, pageSize: PAGE_SIZE, filters: nextFilters });
      if (isActionFail(res)) {
        toast.danger(tError("code", { code: res.error }));
        return;
      }
      setLogs(res);
    });
  }

  function openDetail(row: RequestLogRow) {
    setDetail(null);
    detailState.open();
    loadLogDetailAction(row.id).then((res) => {
      if (isActionFail(res)) {
        detailState.close();
        toast.danger(tError("code", { code: res.error }));
        return;
      }
      setDetail(res);
    });
  }

  useEffect(() => {
    if (page !== 1) return;
    let active = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const tick = () => {
      loadLogsAction({ page: 1, pageSize: PAGE_SIZE, filters }).then((res) => {
        if (active && !isActionFail(res)) setLogs(res);
      });
    };
    const schedule = () => {
      clearInterval(timer);
      timer = document.visibilityState === "visible" ? setInterval(tick, LIVE_INTERVAL_MS) : undefined;
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
  }, [page, filters]);

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

  const total =
    kind === "requests" ? logs.requestTotal : kind === "spend" ? logs.spendTotal : logs.auditTotal;

  return (
    <div>
      <PageHeader
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
        pending={pending}
        options={options}
        onApply={(next) => {
          setFilters(next);
          load(1, next);
        }}
      />
      <Tabs
        selectedKey={kind}
        onSelectionChange={(key) => setKind(String(key) as Kind)}
        aria-label={t("title")}
        className="mb-4 w-fit"
      >
        <Tabs.List className="w-fit min-w-0" aria-label={t("title")}>
          <Tabs.Tab id="requests" className="w-auto">
            {t("tabs.requests")}
          </Tabs.Tab>
          <Tabs.Tab id="spend" className="w-auto">
            {t("tabs.spend")}
          </Tabs.Tab>
          {logs.canAudit ? (
            <Tabs.Tab id="audit" className="w-auto">
              {t("tabs.audit")}
            </Tabs.Tab>
          ) : null}
        </Tabs.List>
      </Tabs>

      <LogTable kind={kind} logs={logs} onOpen={openDetail} />

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {t("pageStatus", { page, total, pageSize: logs.pageSize })}
        </p>
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

      <LogDetailDialog state={detailState} detail={detail} />
    </div>
  );
}
