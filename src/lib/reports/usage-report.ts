import "server-only";

import { createFormatter, createTranslator, type Messages } from "next-intl";
import prisma from "@/lib/db/prisma";
import { formats } from "@/i18n/formats";
import { loadLocaleMessages } from "@/i18n/messages";
import { routing } from "@/i18n/routing";
import {
  CHARGEBACK_COLUMNS,
  chargebackRows,
  chargebackTable,
  groupSpend,
  summarizeUsage,
  usageDays,
} from "@/lib/gateway/usage-stats";
import { p95Latency, usageNames, usageSlices } from "@/lib/gateway/usage-totals";
import { toCsv } from "@/lib/http/export";
import { usageStatsPdf } from "@/lib/http/usage-pdf";
import { logger } from "@/lib/logging/logger";
import { mailEnabled, mailErrorCode, sendMail } from "@/lib/mail/send";
import { lastCompletedPeriod, nextReportAt, REPORT_FORMATS, reportCadence } from "@/lib/reports/period";
import type { MailAttachment, MailInput } from "@/types/mail";
import type { ReportPeriod, UsageReportRow, UsageReportTarget, UsageReportView } from "@/types/reports";

const CLAIM_MS = 10 * 60_000;
const RETRY_MS = 60 * 60_000;
const DAY_MS = 86_400_000;

const targetSelect = {
  id: true,
  orgId: true,
  teamId: true,
  format: true,
  locale: true,
  recipients: true,
  org: { select: { alias: true } },
  team: { select: { alias: true } },
} as const;

function mailError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function fileStem(scope: string, period: ReportPeriod): string {
  const slug = scope
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 48);
  const stamp = period.start.toISOString().slice(0, period.cadence === "monthly" ? 7 : 10);
  return ["llmhub-usage", slug, stamp].filter(Boolean).join("-");
}

export function reportView(row: UsageReportRow, now = new Date()): UsageReportView {
  const cadence = reportCadence(row.cadence);
  return {
    id: row.id,
    orgId: row.orgId,
    teamId: row.teamId ?? "",
    cadence,
    format: REPORT_FORMATS.find((value) => value === row.format) ?? "pdf",
    locale: row.locale,
    recipients: row.recipients,
    enabled: row.enabled,
    lastSentAt: row.lastSentAt?.toISOString() ?? null,
    lastError: row.lastError,
    nextRunAt: nextReportAt(cadence, now).toISOString(),
  };
}

export async function buildReportMail(
  report: UsageReportTarget,
  period: ReportPeriod,
  now = new Date(),
): Promise<MailInput> {
  const locale = routing.locales.find((value) => value === report.locale) ?? routing.defaultLocale;
  const messages = (await loadLocaleMessages(locale)) as Messages;
  const intl = { locale, messages, formats, timeZone: "UTC", now };
  const t = createTranslator({ ...intl, namespace: "Usage" });
  const tCommon = createTranslator({ ...intl, namespace: "Common" });
  const format = createFormatter({ locale, formats, timeZone: "UTC", now });
  const scope = { orgId: report.orgId, ...(report.teamId ? { teamId: report.teamId } : {}) };
  const [rows, p95] = await Promise.all([
    usageSlices({ ...scope, day: { gte: period.start, lt: period.end } }),
    p95Latency({ ...scope, createdAt: { gte: period.start, lt: period.end } }),
  ]);
  const summary = summarizeUsage(rows, usageDays(period.start, period.days));
  const chargeback = chargebackRows(rows);
  const brand = tCommon("appName");
  const scopeName = t("report.scope", {
    hasTeam: report.team ? "yes" : "no",
    org: report.org.alias,
    team: report.team?.alias ?? "",
  });
  const periodName = t("report.period", {
    cadence: period.cadence,
    start: period.start,
    range: format.dateTimeRange(period.start, new Date(period.end.getTime() - DAY_MS), "short"),
  });
  const stem = fileStem(scopeName, period);
  const attachments: MailAttachment[] = [];
  if (report.format !== "csv") {
    attachments.push({
      filename: `${stem}.pdf`,
      contentType: "application/pdf",
      content: usageStatsPdf({
        stats: { ...summary, p95Latency: p95, byModel: groupSpend(rows, "model").slice(0, 12), chargeback },
        t,
        format,
        brand,
        period: periodName,
        filter: scopeName,
        generatedAt: now,
        dayDate: (day) => new Date(`${day}T00:00:00Z`),
      }),
    });
  }
  if (report.format !== "pdf") {
    attachments.push({
      filename: `${stem}.csv`,
      contentType: "text/csv; charset=utf-8",
      content: toCsv(chargebackTable(chargeback, await usageNames(rows)), CHARGEBACK_COLUMNS),
    });
  }
  return {
    to: report.recipients,
    subject: t("report.subject", { brand, scope: scopeName, period: periodName }),
    text: t("report.body", {
      brand,
      scope: scopeName,
      period: periodName,
      spend: summary.spend,
      requests: summary.count,
      errors: summary.errors,
      tokens: summary.tokens,
      format: report.format,
    }),
    attachments,
  };
}

export async function deliverUsageReport(id: string, period: ReportPeriod, now = new Date()): Promise<void> {
  const report = await prisma.usageReport.findUnique({ where: { id }, select: targetSelect });
  if (!report) throw mailError("NOT_FOUND");
  if (!report.recipients.length) throw mailError("RECIPIENTS_REQUIRED");
  const result = await sendMail(await buildReportMail(report, period, now));
  if (!result.sent) throw mailError("MAIL_DISABLED");
}

export async function runUsageReports(now = new Date()): Promise<number> {
  if (!mailEnabled()) return 0;
  const unclaimed = [{ claimedUntil: null }, { claimedUntil: { lt: now } }];
  const due = await prisma.usageReport.findMany({
    where: { enabled: true, recipients: { isEmpty: false }, OR: unclaimed },
    select: { id: true, cadence: true, lastPeriod: true },
  });
  let sent = 0;
  for (const report of due) {
    const period = lastCompletedPeriod(reportCadence(report.cadence), now);
    if (report.lastPeriod === period.key) continue;
    const claimed = await prisma.usageReport.updateMany({
      where: {
        id: report.id,
        enabled: true,
        cadence: report.cadence,
        lastPeriod: report.lastPeriod,
        OR: unclaimed,
      },
      data: { claimedUntil: new Date(now.getTime() + CLAIM_MS) },
    });
    if (claimed.count !== 1) continue;
    try {
      await deliverUsageReport(report.id, period, now);
      await prisma.usageReport.updateMany({
        where: { id: report.id, cadence: report.cadence },
        data: { lastPeriod: period.key, lastSentAt: now, lastError: "", claimedUntil: null },
      });
      sent += 1;
    } catch (err) {
      const code = mailErrorCode(err);
      logger.warn("report.send_failed", { reportId: report.id, err: code });
      await prisma.usageReport
        .updateMany({
          where: { id: report.id },
          data: { lastError: code, claimedUntil: new Date(now.getTime() + RETRY_MS) },
        })
        .catch(() => undefined);
    }
  }
  return sent;
}
