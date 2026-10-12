import "server-only";

import prisma from "@/lib/db/prisma";
import { requirePermission } from "@/lib/auth/guards";
import { consumeQuota } from "@/lib/auth/throttle";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { companyOf, inCompany } from "@/lib/auth/scope";
import { writeAudit } from "@/lib/audit";
import { logger } from "@/lib/logging/logger";
import { mailEnabled, mailErrorCode } from "@/lib/mail/send";
import { lastCompletedPeriod, reportCadence } from "@/lib/reports/period";
import { deliverUsageReport, reportView } from "@/lib/reports/usage-report";
import { usageReportSchema } from "@/schemas/reports";
import type { AuthenticatedSession } from "@/types/auth";
import type { UsageReportView } from "@/types/reports";
import { companyFor, departmentFor } from "@/lib/tenancy/guards";

const REPORT_SENDS_PER_HOUR = 5;
const HOUR_MS = 3_600_000;

export function canReport(session: AuthenticatedSession): boolean {
  return (
    hasPerm(session.permissions, PERMISSIONS.BUDGETS_MANAGE) &&
    hasPerm(session.permissions, PERMISSIONS.SPEND_READ_ALL)
  );
}

export async function reportViews(session: AuthenticatedSession, now = new Date()): Promise<UsageReportView[]> {
  const company = companyOf(session);
  const rows = await prisma.usageReport.findMany({
    where: company ? { orgId: company } : {},
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) => reportView(row, now));
}

async function reportSession(): Promise<AuthenticatedSession> {
  const session = await requirePermission(PERMISSIONS.BUDGETS_MANAGE);
  if (!canReport(session)) throw new Error("FORBIDDEN");
  return session;
}

async function reportInScope(session: AuthenticatedSession, value: unknown) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) throw new Error("MISSING_ID");
  const row = await prisma.usageReport.findUnique({ where: { id } });
  if (!row || !inCompany(session, row.orgId)) throw new Error("NOT_FOUND");
  return row;
}

function parseReport(raw: unknown) {
  const parsed = usageReportSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues.some((issue) => issue.path[0] === "recipients") ? "RECIPIENTS_INVALID" : "VALIDATION",
    );
  }
  if (!parsed.data.recipients.length) throw new Error("RECIPIENTS_REQUIRED");
  return parsed.data;
}

export async function saveReport(raw: unknown) {
  const session = await reportSession();
  const input = parseReport(raw);
  const now = new Date();
  const existing = input.id ? await reportInScope(session, input.id) : null;
  const orgId = existing?.orgId ?? (await companyFor(session, input.orgId));
  const teamId = existing ? existing.teamId : await departmentFor(input.teamId, orgId);
  const settings = {
    cadence: input.cadence,
    format: input.format,
    locale: input.locale,
    recipients: input.recipients,
    enabled: input.enabled,
  };
  const restart =
    !existing || existing.cadence !== input.cadence || (!existing.enabled && input.enabled);
  const lastPeriod = restart ? lastCompletedPeriod(input.cadence, now).key : existing.lastPeriod;
  const row = existing
    ? await prisma.usageReport.update({ where: { id: existing.id }, data: { ...settings, lastPeriod } })
    : await prisma.usageReport.create({ data: { ...settings, orgId, teamId, lastPeriod } });
  await writeAudit({
    actor: session.user.id,
    action: existing ? "report.update" : "report.create",
    objectType: "report",
    objectId: row.id,
    before: existing
      ? {
          cadence: existing.cadence,
          format: existing.format,
          locale: existing.locale,
          recipients: existing.recipients,
          enabled: existing.enabled,
        }
      : undefined,
    after: { orgId, teamId, ...settings },
  });
  return { reports: await reportViews(session, now) };
}

export async function deleteReport(id: string) {
  const session = await reportSession();
  const row = await reportInScope(session, id);
  await prisma.usageReport.delete({ where: { id: row.id } });
  await writeAudit({
    actor: session.user.id,
    action: "report.delete",
    objectType: "report",
    objectId: row.id,
    before: {
      orgId: row.orgId,
      teamId: row.teamId,
      cadence: row.cadence,
      format: row.format,
      recipients: row.recipients,
    },
  });
  return { reports: await reportViews(session) };
}

export async function sendReportNow(id: string) {
  const session = await reportSession();
  const row = await reportInScope(session, id);
  if (!mailEnabled()) throw new Error("MAIL_DISABLED");
  if (!row.recipients.length) throw new Error("RECIPIENTS_REQUIRED");
  if (!(await consumeQuota(`report-send:${row.id}`, REPORT_SENDS_PER_HOUR, HOUR_MS))) {
    throw new Error("RATE_LIMITED");
  }
  const now = new Date();
  const period = lastCompletedPeriod(reportCadence(row.cadence), now);
  let error = "";
  try {
    await deliverUsageReport(row.id, period, now);
  } catch (err) {
    error = mailErrorCode(err);
    logger.warn("report.send_failed", { reportId: row.id, err: error });
  }
  await prisma.usageReport.updateMany({
    where: { id: row.id },
    data: error ? { lastError: error } : { lastSentAt: now, lastError: "" },
  });
  await writeAudit({
    actor: session.user.id,
    action: "report.send",
    objectType: "report",
    objectId: row.id,
    after: { period: period.key, recipients: row.recipients, error },
  });
  return { reports: await reportViews(session, now), error };
}
