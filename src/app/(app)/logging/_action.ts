"use server";

import { randomUUID } from "node:crypto";
import { requirePermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { actionFail, runAction } from "@/lib/http/action-result";
import { writeAudit } from "@/lib/gateway/audit";
import {
  anomalyFactor,
  DEFAULT_KEY_EXPIRY_WARNING_DAYS,
  DEFAULT_SPEND_ANOMALY_FACTOR,
  DEFAULT_SPEND_ANOMALY_MIN_COST,
} from "@/lib/gateway/alert-rules";
import { getEnterprise, patchEnterprise } from "@/lib/gateway/settings";
import { WEBHOOK_EVENTS } from "@/lib/gateway/webhook-events";
import { resolveS3Config } from "@/lib/s3/config";
import { alertWebhooksSchema } from "@/schemas/settings";
import type { AlertWebhook } from "@/types/gateway";
import type { AlertRules, AlertWebhookInput, AlertWebhookView } from "@/types/settings";

async function view(canManage: boolean) {
  const enterprise = await getEnterprise();
  return {
    alertWebhooks: (enterprise.alert_webhooks ?? []).map(
      (hook): AlertWebhookView => ({
        id: hook.id,
        url: hook.url,
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
    logRetentionDays: enterprise.log_retention_days ?? 0,
    spendRetentionDays: enterprise.spend_retention_days ?? 0,
    auditRetentionDays: enterprise.audit_retention_days ?? 0,
    objectRetentionDays: enterprise.object_retention_days ?? 30,
    fileRetentionDays: enterprise.file_retention_days ?? 0,
    contentRetentionDays: enterprise.content_retention_days ?? 0,
    logArchive: enterprise.log_archive === true,
    logContent: enterprise.log_content !== false,
    s3Ready: Boolean(await resolveS3Config()),
    canManage,
  };
}

export async function loadLoggingAction() {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.SETTINGS_READ);
    return view(hasPerm(session.permissions, PERMISSIONS.SETTINGS_MANAGE));
  });
}

export async function saveLoggingAction(input: {
  alertWebhooks: AlertWebhookInput[];
  alertRules: AlertRules;
  logRetentionDays: number;
  spendRetentionDays: number;
  auditRetentionDays: number;
  objectRetentionDays: number;
  fileRetentionDays: number;
  contentRetentionDays: number;
  logArchive: boolean;
  logContent: boolean;
}) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
    const parsed = alertWebhooksSchema.safeParse(input.alertWebhooks);
    if (!parsed.success) {
      const badUrl = parsed.error.issues.some((issue) => issue.path.at(-1) === "url");
      return actionFail(badUrl ? "INVALID_URL" : "VALIDATION");
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
      log_retention_days: Math.max(0, Math.trunc(input.logRetentionDays) || 0),
      spend_retention_days: Math.max(0, Math.trunc(input.spendRetentionDays) || 0),
      audit_retention_days: Math.max(0, Math.trunc(input.auditRetentionDays) || 0),
      object_retention_days: Math.max(0, Math.trunc(input.objectRetentionDays) || 0),
      file_retention_days: Math.max(0, Math.trunc(input.fileRetentionDays) || 0),
      content_retention_days: Math.max(0, Math.trunc(input.contentRetentionDays) || 0),
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
    return view(true);
  });
}
