"use client";

import { useState, useTransition } from "react";
import { Alert, Button, Card, Chip, Spinner, Table, toast, useOverlayState } from "@heroui/react";
import { Pencil, Plus, Send, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import ConfirmDialog from "@/components/console/confirm-dialog";
import { isActionFail } from "@/lib/http/action-result";
import type { MemberNode } from "@/types/structure";
import type { UsageReportView } from "@/types/reports";
import { deleteReportAction, sendReportNowAction } from "../_action";
import ReportDialog from "./report-dialog";

export default function ReportsCard({
  kind,
  name,
  orgId,
  teamId,
  reports,
  people,
  canReport,
  mailEnabled,
  onChange,
}: {
  kind: "org" | "team";
  name: string;
  orgId: string;
  teamId: string;
  reports: UsageReportView[];
  people: MemberNode[];
  canReport: boolean;
  mailEnabled: boolean;
  onChange: (reports: UsageReportView[]) => void;
}) {
  const t = useTranslations("Companies.reports");
  const tCommon = useTranslations("Common");
  const tError = useTranslations("Error");
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
        toast.danger(tError("code", { code: result.error }));
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
        toast.danger(tError("code", { code: result.error }));
        return;
      }
      onChange(result.reports);
      toast(t("deleted"), { variant: "success" });
    });
  }

  return (
    <Card>
      <Card.Header className="flex-row flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Card.Title>{t("title", { count: reports.length })}</Card.Title>
          <Card.Description>{t("hint", { kind })}</Card.Description>
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
          <Table>
            <Table.ScrollContainer>
              <Table.Content aria-label={t("title", { count: reports.length })} className="min-w-xl">
                <Table.Header>
                  <Table.Column isRowHeader>{t("columns.schedule")}</Table.Column>
                  <Table.Column>{t("columns.recipients")}</Table.Column>
                  {canReport ? <Table.Column>{tCommon("actions")}</Table.Column> : null}
                </Table.Header>
                <Table.Body>
                  {reports.map((report) => {
                    const label = t("row", {
                      cadence: report.cadence,
                      first: report.recipients[0] ?? "",
                      more: Math.max(0, report.recipients.length - 1),
                    });
                    return (
                      <Table.Row key={report.id} id={report.id}>
                        <Table.Cell>
                          <div className="min-w-0">
                            <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                              {t("schedule", { cadence: report.cadence, format: report.format })}
                              {report.enabled ? null : (
                                <Chip size="sm" variant="soft" color="warning">
                                  {t("paused")}
                                </Chip>
                              )}
                            </p>
                            <p className="text-xs text-muted">
                              {t("language", {
                                language: format.displayName(report.locale, { type: "language" }) ?? report.locale,
                              })}
                            </p>
                            <div className="mt-2 space-y-0.5 text-xs">
                              {report.enabled ? (
                                <p>{t("next", { date: new Date(report.nextRunAt) })}</p>
                              ) : null}
                              {report.lastError ? (
                                <p className="text-danger">{t("failed", { code: report.lastError })}</p>
                              ) : null}
                              <p className="text-muted">
                                {report.lastSentAt
                                  ? t("lastSent", { date: new Date(report.lastSentAt) })
                                  : t("never")}
                              </p>
                            </div>
                          </div>
                        </Table.Cell>
                        <Table.Cell>
                          <ul className="text-sm wrap-break-word">
                            {report.recipients.map((email) => (
                              <li key={email}>{email}</li>
                            ))}
                          </ul>
                        </Table.Cell>
                        {canReport ? (
                          <Table.Cell>
                            <div className="flex gap-1">
                              <Button
                                isIconOnly
                                size="sm"
                                variant="ghost"
                                aria-label={t("sendNow", { report: label })}
                                isPending={pending && busy === `send:${report.id}`}
                                isDisabled={!mailEnabled || pending}
                                onPress={() => sendNow(report)}
                              >
                                {({ isPending }) =>
                                  isPending ? <Spinner color="current" size="sm" /> : <Send size={14} aria-hidden />
                                }
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
                            </div>
                          </Table.Cell>
                        ) : null}
                      </Table.Row>
                    );
                  })}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        )}
      </Card.Content>
      {canReport ? (
        <ReportDialog
          key={dialogKey}
          state={dialogState}
          report={editing}
          kind={kind}
          name={name}
          orgId={orgId}
          teamId={teamId}
          people={people}
          onSaved={onChange}
        />
      ) : null}
    </Card>
  );
}
