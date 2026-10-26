import type { z } from "zod";
import type { alertWebhooksSchema, catalogSettingsSchema, generalSettingsSchema } from "@/schemas/settings";
import type { AlertWebhook, WebhookEvent, WebhookFormat } from "@/types/alerts";
import type {
  OidcDiscoveryFailure,
  OidcDiscoveryFailureDetail,
  OidcSettings,
  OidcTokenAuth,
  RoleOption,
} from "@/types/auth";
import type { SemanticCacheSettings } from "@/types/cache";
import type { GuardrailPolicy, PiiDetectorSettings, PiiPolicy } from "@/types/guardrails";
import type { JevSettings } from "@/types/model-catalog";
import type { AntigravitySettings } from "@/types/providers";
import type { VectorStoreDefaults } from "@/types/rag";
import type { FeatureModelChoice } from "@/types/models";
import type { S3Settings } from "@/types/s3";
import type { UpdaterView, UpdateStatus } from "@/types/updates";

export type SettingsTab = "general" | "sign-in" | "storage" | "logging" | "cache" | "catalog";

export type GeneralSettings = z.infer<typeof generalSettingsSchema>;

export type GeneralSettingsView = {
  settings: GeneralSettings;
  updates: UpdateStatus;
  updater: UpdaterView | null;
  env: { appUrl: string; s3Keys: boolean; oidcSecret: boolean; smtp: boolean; redis: boolean };
  canManage: boolean;
};

export type SignInSettingsView = {
  oidc: OidcSettings;
  callbackUrl: string;
  scimUrl: string;
  secretSet: boolean;
  roles: RoleOption[];
  orgs: { id: string; alias: string }[];
  scimTokenSet: boolean;
  scimGroups: number;
  canManage: boolean;
  canManageScim: boolean;
};

export type IssuerCheck =
  | {
      ok: true;
      issuer: string;
      usesTenantId: boolean;
      tokenAuth: OidcTokenAuth;
      algorithms: string[];
      supported: boolean;
    }
  | ({ ok: false; reason: OidcDiscoveryFailure } & OidcDiscoveryFailureDetail);

export type StorageSettingsView = {
  settings: S3Settings;
  keys: { accessKeyId: boolean; secretAccessKey: boolean };
  active: boolean;
  canManage: boolean;
};

export type CatalogSettings = z.infer<typeof catalogSettingsSchema>;

export type CatalogSettingsView = {
  settings: CatalogSettings;
  jevKeySet: boolean;
  models: FeatureModelChoice[];
  canManage: boolean;
};

export type LoggingSettingsView = {
  alertWebhooks: AlertWebhookView[];
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
  s3Ready: boolean;
  canManage: boolean;
  budgetAlerts: { thresholds: number[]; canManage: boolean };
  labelKeys: string[];
};

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
  usage_retention_days?: number;
  audit_retention_days?: number;
  security_retention_days?: number;
  object_retention_days?: number;
  file_retention_days?: number;
  cache_ttl_seconds?: number;
  cache_semantic?: SemanticCacheSettings;
  log_archive?: boolean;
  log_content?: boolean;
  content_retention_days?: number;
  pii?: PiiPolicy;
  pii_detector?: PiiDetectorSettings;
  guardrails?: GuardrailPolicy;
  s3?: S3Settings;
  budget_alert_thresholds?: number[];
  label_keys?: string[];
  spend_anomaly_factor?: number;
  spend_anomaly_min_cost?: number;
  key_expiry_warning_days?: number;
  registration_enabled?: boolean;
  catalog_jev?: JevSettings;
  antigravity?: AntigravitySettings;
  catalog_auto_routes?: boolean;
  catalog_min_confidence?: number;
  update_check?: boolean;
  auto_update?: boolean;
  vector_stores?: VectorStoreDefaults;
};
