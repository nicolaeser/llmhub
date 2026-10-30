"use client";

import { useCallback, useMemo, useState } from "react";
import { Button, Tabs, useOverlayState } from "@heroui/react";
import { Activity, ArrowLeft, Download, ListFilter } from "lucide-react";
import { useTranslations } from "next-intl";
import CopyButton from "@/components/console/copy-button";
import EmptyState from "@/components/console/empty-state";
import PageHeader from "@/components/console/page-header";
import { LoadError, PageLoading } from "@/components/console/page-status";
import { useErrorToast } from "@/components/console/use-error-toast";
import { useRouter } from "@/i18n/routing";
import { logFilterParams } from "@/lib/gateway/request-logs/request-log-query";
import { useActionData } from "@/lib/hooks/use-action-data";
import { setSearchParams, useSearchString } from "@/lib/hooks/use-search-param";
import { isActionFail } from "@/lib/http/action-result";
import type { LogSessionRef, RequestLogDetail } from "@/types/logs";
import { loadLogDetailAction, loadLogSessionAction } from "../_action";
import LogDetailDialog from "../_components/log-detail-dialog";
import { NO_FILTERS } from "../_components/log-filters";
import { download, exportHref } from "../_components/log-export";
import SessionChat from "../_components/session-chat";
import { ActiveChip, useCallerLabels } from "../_components/session-cells";
import { useSessionFormat } from "../_components/session-format";
import SessionTrace from "../_components/session-trace";
import { useLiveReload } from "../_components/use-live-reload";

const VIEWS = ["chat", "requests"] as const;
type View = (typeof VIEWS)[number];

function refOf(search: string): LogSessionRef | null {
  const params = new URLSearchParams(search);
  const sessionId = params.get("id");
  if (!sessionId) return null;
  return { sessionId, keyId: params.get("key") ?? "", userId: params.get("user") ?? "" };
}

function viewOf(search: string): View {
  const requested = new URLSearchParams(search).get("tab");
  return VIEWS.find((view) => view === requested) ?? "chat";
}

export default function LogSessionPage() {
  const t = useTranslations("Logs");
  const tSessions = useTranslations("Logs.sessions");
  const showError = useErrorToast();
  const router = useRouter();
  const session = useSessionFormat();
  const caller = useCallerLabels();
  const search = useSearchString();
  const sessionRef = useMemo(() => refOf(search ?? ""), [search]);
  const view = viewOf(search ?? "");
  const [detail, setDetail] = useState<RequestLogDetail | null>(null);
  const detailState = useOverlayState();
  const state = useActionData(() => {
    const ref = refOf(window.location.search);
    if (!ref) throw new Error("VALIDATION");
    return loadLogSessionAction({ ref, page: 1 });
  });
  const { data, pending, setData } = state;
  const page = data?.page ?? 1;

  const refresh = useCallback(() => {
    if (!sessionRef) return;
    loadLogSessionAction({ ref: sessionRef, page }).then((res) => {
      if (!isActionFail(res)) setData((current) => (current.page === res.page ? res : current));
    });
  }, [sessionRef, page, setData]);
  useLiveReload(Boolean(data?.session.active) && !pending, refresh);

  function openDetail(id: string) {
    setDetail(null);
    detailState.open();
    loadLogDetailAction(id).then((res) => {
      if (isActionFail(res)) {
        detailState.close();
        showError(res.error);
        return;
      }
      setDetail(res);
    });
  }

  function showRequests(ref: LogSessionRef) {
    const params = new URLSearchParams();
    const next = { ...NO_FILTERS, session: ref.sessionId, keyId: ref.keyId, userId: ref.userId };
    for (const [key, value] of Object.entries(logFilterParams(next))) {
      if (value !== null) params.set(key, value);
    }
    router.push(`/logs?${params.toString()}`);
  }

  const back = (
    <Button size="sm" variant="tertiary" className="mb-4" onPress={() => router.push("/logs?tab=sessions")}>
      <ArrowLeft size={14} aria-hidden />
      {tSessions("back")}
    </Button>
  );

  if (search !== undefined && !sessionRef) {
    return (
      <div>
        {back}
        <EmptyState icon={Activity} title={tSessions("missing")} description={tSessions("missingHint")} />
      </div>
    );
  }

  if (!data || !sessionRef) {
    return (
      <div>
        {back}
        {state.error === null ? <PageLoading icon={Activity} header tabs layout="chat" /> : <LoadError state={state} />}
      </div>
    );
  }

  const summary = data.session;

  return (
    <div>
      {back}
      <PageHeader
        icon={Activity}
        title={session.title(summary.agent)}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <ActiveChip active={summary.active} />
            <span>{tSessions("callerLine", { key: caller.key(summary), person: caller.person(summary) })}</span>
            <span className="flex min-w-0 items-center gap-1">
              <code className="min-w-0 font-mono text-xs break-all">{summary.sessionId}</code>
              <CopyButton text={summary.sessionId} label={tSessions("copy")} />
            </span>
          </span>
        }
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" onPress={() => showRequests(sessionRef)}>
              <ListFilter size={14} aria-hidden />
              {tSessions("showRequests")}
            </Button>
            <Button
              variant="secondary"
              onPress={() => download(exportHref("requests", "csv", { ...NO_FILTERS, session: sessionRef.sessionId, keyId: sessionRef.keyId, userId: sessionRef.userId }))}
            >
              <Download size={14} aria-hidden />
              {tSessions("exportRequests")}
            </Button>
          </div>
        }
      />
      <Tabs
        variant="secondary"
        selectedKey={view}
        onSelectionChange={(key) => setSearchParams({ tab: String(key) })}
        className="mb-4 max-w-full"
      >
        <Tabs.ListContainer>
          <Tabs.List aria-label={t("title")}>
            <Tabs.Tab id="chat" className="w-auto whitespace-nowrap">
              {tSessions("views.chat")}
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="requests" className="w-auto whitespace-nowrap">
              {t("tabs.requests")}
              <Tabs.Indicator />
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
      </Tabs>
      <LoadError state={state} className="mb-4" />
      {view === "chat" ? (
        <SessionChat sessionRef={sessionRef} agent={summary.agent} active={summary.active} onOpenRequest={openDetail} />
      ) : (
        <SessionTrace
          data={data}
          pending={pending}
          onPage={(next) => state.reloadWith(() => loadLogSessionAction({ ref: sessionRef, page: next }))}
          onOpenRequest={openDetail}
        />
      )}
      <LogDetailDialog
        state={detailState}
        detail={detail}
        onExport={(format) => {
          if (detail) download(`/internal-api/logs/${encodeURIComponent(detail.id)}/export?format=${format}`);
        }}
      />
    </div>
  );
}
