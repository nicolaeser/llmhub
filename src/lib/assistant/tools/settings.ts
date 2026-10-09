import "server-only";

import { isActionFail } from "@/lib/http/action-result";
import { loadAdminSettingsAction } from "@/app/(app)/admin-settings/_action";
import { loadCacheAction, saveCacheAction } from "@/app/(app)/cache/_action";
import {
  loadGuardrailsAction,
  saveGuardrailsAction,
  savePiiOverrideAction,
  testPiiAction,
} from "@/app/(app)/guardrails/_action";
import { loadLoggingAction, saveLoggingAction } from "@/app/(app)/logging/_action";
import {
  emptyToolInput,
  gatewaySettingsToolInput,
  testPiiToolInput,
  updateGuardrailsToolInput,
} from "@/schemas/assistant";
import { actionCode, defineTool, toolFail, viaAction } from "@/lib/assistant/tools/define";
import type { AssistantToolResult } from "@/types/assistant";
import type { PiiPolicy } from "@/types/guardrails";
import type { z } from "zod";

function webhookHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function mergePii(base: PiiPolicy, args: z.output<typeof updateGuardrailsToolInput>): PiiPolicy {
  return {
    enabled: args.enabled ?? base.enabled,
    mode: args.mode ?? base.mode,
    output: args.output ?? base.output,
    entities: args.entities ?? base.entities,
  };
}

async function updateGuardrails(args: z.output<typeof updateGuardrailsToolInput>): Promise<AssistantToolResult> {
  const current = await loadGuardrailsAction();
  if (isActionFail(current)) return toolFail(actionCode(current));
  if (args.scope === "global") {
    return viaAction(saveGuardrailsAction(mergePii(current.pii, args)), ({ pii }) => ({
      result: { ok: true, scope: "global", policy: pii },
      navigate: "/guardrails",
    }));
  }
  if (!args.id) return toolFail("invalid_arguments", { issues: [{ path: "id", message: "required" }] });
  const existing = current.overrides.find((row) => row.scope === args.scope && row.id === args.id);
  const policy = args.inherit ? null : mergePii(existing?.policy ?? current.pii, args);
  return viaAction(savePiiOverrideAction({ scope: args.scope, id: args.id, policy }), (saved) => ({
    result: { ok: true, scope: saved.scope, id: saved.id, override: saved.override?.policy ?? null },
    navigate: "/guardrails",
  }));
}

async function updateGatewaySettings(
  args: z.output<typeof gatewaySettingsToolInput>,
): Promise<AssistantToolResult> {
  const changed: Record<string, unknown> = {};
  if (args.cacheTtlSeconds !== undefined) {
    const saved = await saveCacheAction({ cacheTtlSeconds: args.cacheTtlSeconds });
    if (isActionFail(saved)) return toolFail(actionCode(saved));
    changed.cacheTtlSeconds = saved.cacheTtlSeconds;
  }
  const loggingChanged = [
    args.logRetentionDays,
    args.spendRetentionDays,
    args.auditRetentionDays,
    args.objectRetentionDays,
    args.fileRetentionDays,
    args.contentRetentionDays,
    args.logArchive,
    args.logContent,
    args.spendAnomalyFactor,
    args.spendAnomalyMinCost,
    args.keyExpiryWarningDays,
  ].some((value) => value !== undefined);
  if (loggingChanged) {
    const current = await loadLoggingAction();
    if (isActionFail(current)) return toolFail(actionCode(current));
    const saved = await saveLoggingAction({
      alertWebhooks: current.alertWebhooks.map((hook) => ({
        id: hook.id,
        url: hook.url,
        format: hook.format,
        events: hook.events,
        secret: "",
        clearSecret: false,
      })),
      alertRules: {
        spendAnomalyFactor: args.spendAnomalyFactor ?? current.alertRules.spendAnomalyFactor,
        spendAnomalyMinCost: args.spendAnomalyMinCost ?? current.alertRules.spendAnomalyMinCost,
        keyExpiryWarningDays: args.keyExpiryWarningDays ?? current.alertRules.keyExpiryWarningDays,
      },
      logRetentionDays: args.logRetentionDays ?? current.logRetentionDays,
      spendRetentionDays: args.spendRetentionDays ?? current.spendRetentionDays,
      auditRetentionDays: args.auditRetentionDays ?? current.auditRetentionDays,
      objectRetentionDays: args.objectRetentionDays ?? current.objectRetentionDays,
      fileRetentionDays: args.fileRetentionDays ?? current.fileRetentionDays,
      contentRetentionDays: args.contentRetentionDays ?? current.contentRetentionDays,
      logArchive: args.logArchive ?? current.logArchive,
      logContent: args.logContent ?? current.logContent,
    });
    if (isActionFail(saved)) return toolFail(actionCode(saved));
    Object.assign(changed, {
      logRetentionDays: saved.logRetentionDays,
      spendRetentionDays: saved.spendRetentionDays,
      auditRetentionDays: saved.auditRetentionDays,
      objectRetentionDays: saved.objectRetentionDays,
      fileRetentionDays: saved.fileRetentionDays,
      contentRetentionDays: saved.contentRetentionDays,
      logArchive: saved.logArchive,
      logContent: saved.logContent,
      alertRules: saved.alertRules,
    });
  }
  if (!Object.keys(changed).length) return toolFail("nothing_to_change");
  return { result: { ok: true, ...changed } };
}

export const settingsTools = {
  get_settings: defineTool({
    description:
      "Gateway settings: response cache TTL, retention days, content logging, S3 archive, alert webhooks (host, format, and events only), alert rules, registration, single sign-on, S3 storage, and the assistant model policy. Never secrets.",
    input: emptyToolInput,
    run: async () => {
      const [logging, cache, admin] = await Promise.all([
        loadLoggingAction(),
        loadCacheAction(),
        loadAdminSettingsAction(),
      ]);
      if (isActionFail(logging)) return toolFail(actionCode(logging));
      if (isActionFail(cache)) return toolFail(actionCode(cache));
      if (isActionFail(admin)) return toolFail(actionCode(admin));
      return {
        result: {
          cacheTtlSeconds: cache.cacheTtlSeconds,
          retentionDays: {
            logs: logging.logRetentionDays,
            spend: logging.spendRetentionDays,
            audit: logging.auditRetentionDays,
            objects: logging.objectRetentionDays,
            files: logging.fileRetentionDays,
            content: logging.contentRetentionDays,
          },
          logContent: logging.logContent,
          logArchive: logging.logArchive,
          alertRules: logging.alertRules,
          s3Ready: logging.s3Ready,
          alertWebhooks: logging.alertWebhooks.map((hook) => ({
            id: hook.id,
            host: webhookHost(hook.url),
            format: hook.format,
            events: hook.events,
            signed: hook.secretSet,
          })),
          registrationEnabled: admin.settings.registration_enabled,
          sso: {
            enabled: admin.settings.oidc.enabled,
            issuer: admin.settings.oidc.issuer,
            clientSecretConfigured: admin.oidcEnv,
          },
          s3: {
            enabled: admin.settings.s3.enabled,
            bucket: admin.settings.s3.bucket,
            region: admin.settings.s3.region,
          },
          smtpConfigured: admin.smtpEnv,
          scimTokenSet: admin.scimTokenSet,
          assistantModel: {
            default: admin.settings.assistant_model,
            enforced: admin.settings.assistant_model_locked,
          },
        },
      };
    },
  }),
  get_guardrails: defineTool({
    description: "The global PII policy and every organization and key override.",
    input: emptyToolInput,
    run: async () =>
      viaAction(loadGuardrailsAction(), ({ pii, overrides }) => ({
        result: {
          global: pii,
          overrides: overrides.map((row) => ({ scope: row.scope, id: row.id, alias: row.alias, policy: row.policy })),
        },
      })),
  }),
  test_pii: defineTool({
    description: "Show how the global PII policy would mask a sample text.",
    input: testPiiToolInput,
    run: async ({ text }) =>
      viaAction(testPiiAction(text), ({ redacted }) => ({ result: { redacted } })),
  }),
  update_guardrails: defineTool({
    description:
      "Change the global PII policy, or set or remove (inherit) an override for one organization or key. Omitted fields keep their current value.",
    input: updateGuardrailsToolInput,
    run: async (args) => updateGuardrails(args),
  }),
  update_gateway_settings: defineTool({
    description:
      "Change the response cache TTL, retention days, request content logging, S3 log archiving, or the spend anomaly and key expiry alert rules. Omitted fields stay unchanged. Alert webhooks are edited on the Logging page.",
    input: gatewaySettingsToolInput,
    run: async (args) => updateGatewaySettings(args),
  }),
};
