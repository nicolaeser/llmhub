"use client";

import { useState, useTransition } from "react";
import { Alert, Button, Card, Chip, Spinner, Table, toast, useOverlayState } from "@heroui/react";
import { Pencil, Plus, Send, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import ConfirmDialog from "@/components/console/confirm-dialog";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import { isActionFail } from "@/lib/http/action-result";
import type { MemberNode } from "@/types/structure";
import type { UsageReportView } from "@/types/reports";
import { deleteReportAction, sendReportNowAction } from "../_action";
import ReportDialog from "./report-dialog";
import { useErrorToast } from "@/components/console/use-error-toast";

export default function ReportsCard({
  company,
  departments,
  reports,
  people,
  canReport,
  mailEnabled,
  onChange,
}: {
  company: { id: string; alias: string };
  departments: { id: string; alias: string }[];
  reports: UsageReportView[];
  people: MemberNode[];
  canReport: boolean;
  mailEnabled: boolean;
  onChange: (reports: UsageReportView[]) => void;
}) {
  const t = useTranslations("Companies.reports");
  const tCommon = useTranslations("Common");
  const showError = useErrorToast();
  const format = useFormatter();
  const dialogState = useOverlayState();
  const [editing, setEditing] = useState<UsageReportView | null>(null);
  const [dialogKey, setDialogKey] = useState(0);
  const [busy, setBusy] = useState("");
  const [pending, start] = useTransition();

  function openDialog(report: UsageReportView | null) {
    setEditing(report);
    setDialogKey((n) => n + 1);
    dialogState.open();
  }

  function sendNow(report: UsageReportView) {
    setBusy(`send:${report.id}`);
    start(async () => {
      const result = await sendReportNowAction(report.id);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onChange(result.reports);
      if (result.error) toast.danger(t("sendFailed", { code: result.error }));
      else toast(t("sent"), { variant: "success" });
    });
  }

  function remove(report: UsageReportView) {
    setBusy(`delete:${report.id}`);
    start(async () => {
      const result = await deleteReportAction(report.id);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onChange(result.reports);
      toast(t("deleted"), { variant: "success" });
    });
  }

  function reportLabel(report: UsageReportView) {
    return t("row", {
      cadence: report.cadence,
      first: report.recipients[0] ?? "",
      more: Math.max(0, report.recipients.length - 1),
    });
  }

  function pausedChip(report: UsageReportView) {
    if (report.enabled) return null;
    return (
      <Chip size="sm" variant="soft" color="warning">
        {t("paused")}
      </Chip>
    );
  }

  function languageLabel(report: UsageReportView) {
    return t("language", {
      language: format.displayName(report.locale, { type: "language" }) ?? report.locale,
    });
  }

  function coverage(report: UsageReportView) {
    const department = departments.find((row) => row.id === report.teamId);
    return t("covers", { kind: department ? "team" : "org", name: department?.alias ?? company.alias });
  }

  function subtitle(report: UsageReportView) {
    return format.list([coverage(report), languageLabel(report)], { type: "unit" });
  }

  function deliveryStatus(report: UsageReportView) {
    return (
      <div className="space-y-0.5 text-xs">
        {report.enabled ? <p>{t("next", { date: new Date(report.nextRunAt) })}</p> : null}
        {report.lastError ? <p className="text-danger">{t("failed", { code: report.lastError })}</p> : null}
        <p className="text-muted">
          {report.lastSentAt ? t("lastSent", { date: new Date(report.lastSentAt) }) : t("never")}
        </p>
      </div>
    );
  }

  function recipientList(report: UsageReportView) {
    return (
      <ul className="text-sm wrap-break-word">
        {report.recipients.map((email) => (
          <li key={email}>{email}</li>
        ))}
      </ul>
    );
  }

  function reportActions(report: UsageReportView) {
    const label = reportLabel(report);
    return (
      <>
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label={t("sendNow", { report: label })}
          isPending={pending && busy === `send:${report.id}`}
          isDisabled={!mailEnabled || pending}
          onPress={() => sendNow(report)}
        >
          {({ isPending }) => (isPending ? <Spinner color="current" size="sm" /> : <Send size={14} aria-hidden />)}
        </Button>
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label={t("edit", { report: label })}
          isDisabled={pending}
          onPress={() => openDialog(report)}
        >
          <Pencil size={14} aria-hidden />
        </Button>
        <ConfirmDialog
          title={t("deleteTitle")}
          description={t("deleteHint")}
          confirmLabel={tCommon("delete")}
          cancelLabel={tCommon("cancel")}
          pending={pending && busy === `delete:${report.id}`}
          onConfirm={() => remove(report)}
        >
          <Button
            isIconOnly
            size="sm"
            variant="danger-soft"
            aria-label={t("delete", { report: label })}
            isDisabled={pending}
          >
            <Trash2 size={14} aria-hidden />
          </Button>
        </ConfirmDialog>
      </>
    );
  }

  return (
    <Card>
      <Card.Header className="flex-row flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Card.Title>{t("title", { count: reports.length })}</Card.Title>
          <Card.Description>{t("hint")}</Card.Description>
        </div>
        {canReport ? (
          <Button size="sm" onPress={() => openDialog(null)}>
            <Plus size={14} aria-hidden />
            {t("add")}
          </Button>
        ) : null}
      </Card.Header>
      <Card.Content className="space-y-4">
        {!mailEnabled ? (
          <Alert status="warning">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{t("mailDisabled")}</Alert.Description>
            </Alert.Content>
          </Alert>
        ) : null}
        {reports.length === 0 ? (
          <p className="text-sm text-muted">{t("empty")}</p>
        ) : (
          <>
            <RowCards label={t("title", { count: reports.length })}>
              {reports.map((report) => (
                <RowCard
                  key={report.id}
                  variant="secondary"
                  title={t("schedule", { cadence: report.cadence, format: report.format })}
                  description={subtitle(report)}
                  chips={pausedChip(report)}
                  details={[
                    { label: tCommon("status"), value: deliveryStatus(report), wide: true },
                    { label: t("columns.recipients"), value: recipientList(report), wide: true },
                  ]}
                  actions={canReport ? reportActions(report) : undefined}
                />
              ))}
            </RowCards>
            <Table className={TABLE_FROM_LG}>
              <Table.ScrollContainer>
                <Table.Content aria-label={t("title", { count: reports.length })} className="min-w-xl">
                  <Table.Header>
                    <Table.Column isRowHeader>{t("columns.schedule")}</Table.Column>
                    <Table.Column>{t("columns.recipients")}</Table.Column>
                    {canReport ? <Table.Column>{tCommon("actions")}</Table.Column> : null}
                  </Table.Header>
                  <Table.Body>
                    {reports.map((report) => (
                      <Table.Row key={report.id} id={report.id}>
                        <Table.Cell>
                          <div className="min-w-0">
                            <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                              {t("schedule", { cadence: report.cadence, format: report.format })}
                              {pausedChip(report)}
                            </p>
                            <p className="text-xs text-muted">{subtitle(report)}</p>
                            <div className="mt-2">{deliveryStatus(report)}</div>
                          </div>
                        </Table.Cell>
                        <Table.Cell>{recipientList(report)}</Table.Cell>
                        {canReport ? (
                          <Table.Cell>
                            <div className="flex gap-1">{reportActions(report)}</div>
                          </Table.Cell>
                        ) : null}
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Content>
              </Table.ScrollContainer>
            </Table>
          </>
        )}
      </Card.Content>
      {canReport ? (
        <ReportDialog
          key={dialogKey}
          state={dialogState}
          report={editing}
          company={company}
          departments={departments}
          people={people}
          onSaved={onChange}
        />
      ) : null}
    </Card>
  );
}
