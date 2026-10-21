import "server-only";

import { randomUUID } from "node:crypto";
import { requirePlatformPermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { writeAudit } from "@/lib/audit";
import {
  anomalyFactor,
  DEFAULT_KEY_EXPIRY_WARNING_DAYS,
  DEFAULT_SPEND_ANOMALY_FACTOR,
  DEFAULT_SPEND_ANOMALY_MIN_COST,
} from "@/lib/alerts/rules";
import { getEnterprise, patchEnterprise } from "@/lib/settings/enterprise";
import { WEBHOOK_EVENTS } from "@/lib/alerts/events";
import { resolveS3Config } from "@/lib/s3/config";
import {
  DEFAULT_CONTENT_RETENTION_DAYS,
  DEFAULT_LOG_RETENTION_DAYS,
  DEFAULT_OBJECT_RETENTION_DAYS,
  DEFAULT_SECURITY_RETENTION_DAYS,
  clampRetentionDays,
} from "@/lib/settings/retention-defaults";
import { alertWebhooksSchema } from "@/schemas/settings";
import type { AlertWebhook } from "@/types/alerts";
import type { AuthenticatedSession } from "@/types/auth";
import type { AlertRules, AlertWebhookInput, AlertWebhookView, LoggingSettingsView } from "@/types/settings";

export function visibleWebhookUrl(url: string, canManage: boolean): string {
  if (canManage) return url;
  return URL.canParse(url) ? new URL(url).origin : "";
}

async function view(session: AuthenticatedSession): Promise<LoggingSettingsView> {
  const enterprise = await getEnterprise();
  const canManage = hasPerm(session.permissions, PERMISSIONS.SETTINGS_MANAGE);
  return {
    alertWebhooks: (enterprise.alert_webhooks ?? []).map(
      (hook): AlertWebhookView => ({
        id: hook.id,
        url: visibleWebhookUrl(hook.url, canManage),
        format: hook.format,
        events: hook.events,
        secretSet: Boolean(hook.secret),
      }),
    ),
    alertRules: {
      spendAnomalyFactor: enterprise.spend_anomaly_factor ?? DEFAULT_SPEND_ANOMALY_FACTOR,
      spendAnomalyMinCost: enterprise.spend_anomaly_min_cost ?? DEFAULT_SPEND_ANOMALY_MIN_COST,
      keyExpiryWarningDays: enterprise.key_expiry_warning_days ?? DEFAULT_KEY_EXPIRY_WARNING_DAYS,
    },
    logRetentionDays: enterprise.log_retention_days ?? DEFAULT_LOG_RETENTION_DAYS,
    spendRetentionDays: enterprise.spend_retention_days ?? 0,
    usageRetentionDays: enterprise.usage_retention_days ?? 0,
    auditRetentionDays: enterprise.audit_retention_days ?? 0,
    securityRetentionDays: enterprise.security_retention_days ?? DEFAULT_SECURITY_RETENTION_DAYS,
    objectRetentionDays: enterprise.object_retention_days ?? DEFAULT_OBJECT_RETENTION_DAYS,
    fileRetentionDays: enterprise.file_retention_days ?? 0,
    contentRetentionDays: enterprise.content_retention_days ?? DEFAULT_CONTENT_RETENTION_DAYS,
    logArchive: enterprise.log_archive === true,
    logContent: enterprise.log_content !== false,
    s3Ready: Boolean(await resolveS3Config()),
    canManage,
    budgetAlerts: {
      thresholds: enterprise.budget_alert_thresholds ?? [50, 80, 100],
      canManage: hasPerm(session.permissions, PERMISSIONS.BUDGETS_MANAGE),
    },
  };
}

export async function loadLogging() {
  const session = await requirePlatformPermission(PERMISSIONS.SETTINGS_READ);
  return view(session);
}

export async function saveLogging(input: {
  alertWebhooks: AlertWebhookInput[];
  alertRules: AlertRules;
  logRetentionDays: number;
  spendRetentionDays: number;
  usageRetentionDays: number;
  auditRetentionDays: number;
  securityRetentionDays: number;
  objectRetentionDays: number;
  fileRetentionDays: number;
  contentRetentionDays: number;
  logArchive: boolean;
  logContent: boolean;
}) {
  const session = await requirePlatformPermission(PERMISSIONS.SETTINGS_MANAGE);
  const parsed = alertWebhooksSchema.safeParse(input.alertWebhooks);
  if (!parsed.success) {
    const badUrl = parsed.error.issues.some((issue) => issue.path.at(-1) === "url");
    throw new Error(badUrl ? "INVALID_URL" : "VALIDATION");
  }
  const current = new Map(((await getEnterprise()).alert_webhooks ?? []).map((hook) => [hook.id, hook]));
  const alertWebhooks = parsed.data.map((hook): AlertWebhook => {
    const previous = hook.id ? current.get(hook.id) : undefined;
    if (previous) current.delete(previous.id);
    return {
      id: previous?.id ?? randomUUID(),
      url: hook.url,
      secret: hook.clearSecret ? "" : hook.secret || previous?.secret || "",
      format: hook.format,
      events: WEBHOOK_EVENTS.filter((event) => hook.events.includes(event)),
    };
  });
  const after = {
    log_retention_days: clampRetentionDays(input.logRetentionDays),
    spend_retention_days: clampRetentionDays(input.spendRetentionDays),
    usage_retention_days: clampRetentionDays(input.usageRetentionDays),
    audit_retention_days: clampRetentionDays(input.auditRetentionDays),
    security_retention_days: clampRetentionDays(input.securityRetentionDays),
    object_retention_days: clampRetentionDays(input.objectRetentionDays),
    file_retention_days: clampRetentionDays(input.fileRetentionDays),
    content_retention_days: clampRetentionDays(input.contentRetentionDays),
    log_archive: input.logArchive,
    log_content: input.logContent,
    spend_anomaly_factor: anomalyFactor(Number(input.alertRules.spendAnomalyFactor) || 0),
    spend_anomaly_min_cost: Math.max(0, Number(input.alertRules.spendAnomalyMinCost) || 0),
    key_expiry_warning_days: Math.max(0, Math.trunc(input.alertRules.keyExpiryWarningDays) || 0),
  };
  await patchEnterprise({ ...after, alert_webhooks: alertWebhooks });
  await writeAudit({
    actor: session.user.id,
    action: "settings.logging",
    objectType: "enterprise",
    objectId: "enterprise",
    after: {
      ...after,
      alert_webhooks: alertWebhooks.map((hook, i) => ({
        id: hook.id,
        url: hook.url,
        format: hook.format,
        events: hook.events,
        secretChanged: Boolean(parsed.data[i].secret) || parsed.data[i].clearSecret,
      })),
    },
  });
  return view(session);
}
