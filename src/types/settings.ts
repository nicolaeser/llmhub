import type { z } from "zod";
import type { adminSettingsSchema, alertWebhooksSchema } from "@/schemas/settings";
import type { AlertWebhook, WebhookEvent, WebhookFormat } from "@/types/alerts";
import type { OidcSettings } from "@/types/auth";
import type { SemanticCacheSettings } from "@/types/cache";
import type { GuardrailPolicy, PiiPolicy } from "@/types/guardrails";
import type { JevSettings } from "@/types/model-catalog";
import type { AntigravitySettings } from "@/types/providers";
import type { VectorStoreDefaults } from "@/types/rag";
import type { S3Settings } from "@/types/s3";

export type AdminSettings = z.infer<typeof adminSettingsSchema>;

export type AlertWebhookInput = z.infer<typeof alertWebhooksSchema>[number];

export type AlertWebhookView = {
  id: string;
  url: string;
  format: WebhookFormat;
  events: WebhookEvent[];
  secretSet: boolean;
};

export type AlertRules = {
  spendAnomalyFactor: number;
  spendAnomalyMinCost: number;
  keyExpiryWarningDays: number;
};

export type AlertWebhookDraft = AlertWebhookInput & {
  key: string;
  secretSet: boolean;
};

export type Enterprise = {
  oidc?: OidcSettings;
  alert_webhooks?: AlertWebhook[];
  log_retention_days?: number;
  spend_retention_days?: number;
  audit_retention_days?: number;
  object_retention_days?: number;
  file_retention_days?: number;
  cache_ttl_seconds?: number;
  cache_semantic?: SemanticCacheSettings;
  log_archive?: boolean;
  log_content?: boolean;
  content_retention_days?: number;
  pii?: PiiPolicy;
  guardrails?: GuardrailPolicy;
  s3?: S3Settings;
  budget_alert_thresholds?: number[];
  spend_anomaly_factor?: number;
  spend_anomaly_min_cost?: number;
  key_expiry_warning_days?: number;
  registration_enabled?: boolean;
  assistant_model?: string;
  assistant_model_locked?: boolean;
  catalog_jev?: JevSettings;
  antigravity?: AntigravitySettings;
  catalog_auto_routes?: boolean;
  catalog_min_confidence?: number;
  update_check?: boolean;
  vector_stores?: VectorStoreDefaults;
};
