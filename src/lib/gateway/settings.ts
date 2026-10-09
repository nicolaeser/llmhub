import "server-only";
import prisma from "@/lib/db/prisma";
import { open, seal } from "@/lib/crypto";
import {
  asBool,
  asNumber,
  asNumberArray,
  asRecord,
  asString,
  asStringArray,
  asStringMap,
} from "@/lib/gateway/core";
import { modelAlias } from "@/lib/gateway/model-alias";
import { SEMANTIC_THRESHOLD_DEFAULT, SEMANTIC_THRESHOLD_MIN } from "@/lib/gateway/cache-settings";
import { DEFAULT_AUTO_CONFIDENCE, JEV_SUGGEST_CONFIDENCE } from "@/lib/gateway/model-catalog";
import {
  anomalyFactor,
  DEFAULT_KEY_EXPIRY_WARNING_DAYS,
  DEFAULT_SPEND_ANOMALY_FACTOR,
  DEFAULT_SPEND_ANOMALY_MIN_COST,
} from "@/lib/gateway/alert-rules";
import { WEBHOOK_EVENTS, WEBHOOK_FORMATS } from "@/lib/gateway/webhook-events";
import type {
  AlertStateKind,
  AlertWebhook,
  CatalogRouting,
  JsonMap,
  PIIConfig,
  OIDCConfig,
  S3Addressing,
  S3Settings,
  Enterprise,
  JevSettings,
  Principal,
  WebhookFormat,
} from "@/types/gateway";
import type { PiiPolicy } from "@/types/guardrails";
import type { SemanticCacheSettings } from "@/types/cache";
import type { VectorStoreDefaults } from "@/types/rag";

const SETTING_ENTERPRISE = "enterprise";
const ALERT_STATE_SETTINGS: Record<AlertStateKind, string> = {
  budget: "budget_alert_state",
  spend_anomaly: "spend_anomaly_state",
  key_expiry: "key_expiry_alert_state",
};
const LEGACY_WEBHOOK_ID = "legacy";

const DEFAULT_PII: PIIConfig = {
  enabled: true,
  mode: "mask",
  output: true,
  entities: [],
};

export const DEFAULT_JEV_MODEL = "jev-latest";

const DEFAULT_JEV: JevSettings = { enabled: false, model: DEFAULT_JEV_MODEL, api_key: "" };

const DEFAULT_SEMANTIC_CACHE: SemanticCacheSettings = {
  enabled: false,
  model: "",
  threshold: SEMANTIC_THRESHOLD_DEFAULT,
};

const DEFAULT_VECTOR_STORES: VectorStoreDefaults = {
  embedding_model: "",
  embedding_dimensions: 0,
  ocr_model: "",
  rerank_model: "",
};

const DEFAULT_ENTERPRISE: Enterprise = {
  cache_ttl_seconds: 0,
  cache_semantic: DEFAULT_SEMANTIC_CACHE,
  log_retention_days: 0,
  spend_retention_days: 0,
  audit_retention_days: 0,
  object_retention_days: 30,
  file_retention_days: 0,
  content_retention_days: 0,
  alert_webhooks: [],
  log_archive: false,
  log_content: true,
  registration_enabled: false,
  assistant_model: "",
  assistant_model_locked: false,
  catalog_jev: DEFAULT_JEV,
  catalog_auto_routes: true,
  catalog_min_confidence: DEFAULT_AUTO_CONFIDENCE,
  update_check: true,
  vector_stores: DEFAULT_VECTOR_STORES,
  pii: DEFAULT_PII,
  budget_alert_thresholds: [50, 80, 100],
  spend_anomaly_factor: DEFAULT_SPEND_ANOMALY_FACTOR,
  spend_anomaly_min_cost: DEFAULT_SPEND_ANOMALY_MIN_COST,
  key_expiry_warning_days: DEFAULT_KEY_EXPIRY_WARNING_DAYS,
  oidc: {
    enabled: false,
    issuer: "",
    client_id: "",
    redirect_url: "",
  },
  s3: {
    enabled: false,
    bucket: "",
    region: "us-east-1",
    endpoint: "",
    prefix: "",
    addressing: "auto",
    public_base_url: "",
    domain_bucket: false,
  },
};

function normalizePii(raw: unknown): PiiPolicy {
  const rec = asRecord(raw) ?? {};
  const mode = asString(rec.mode, "mask");
  return {
    enabled: rec.enabled == null ? true : asBool(rec.enabled, true),
    mode: mode === "block" ? "block" : "mask",
    output: rec.output == null ? true : asBool(rec.output, true),
    entities: asStringArray(rec.entities),
  };
}

export function webhookFormat(value: unknown): WebhookFormat {
  return WEBHOOK_FORMATS.find((format) => format === value) ?? "json";
}

function normalizeWebhooks(rec: JsonMap): AlertWebhook[] {
  const list = (Array.isArray(rec.alert_webhooks) ? rec.alert_webhooks : []).flatMap((entry) => {
    const hook = asRecord(entry);
    const id = asString(hook?.id);
    const url = asString(hook?.url).trim();
    if (!hook || !id || !url) return [];
    const events = asStringArray(hook.events);
    return [
      {
        id,
        url,
        secret: asString(hook.secret),
        format: webhookFormat(hook.format),
        events: WEBHOOK_EVENTS.filter((e) => events.includes(e)),
      },
    ];
  });
  if (list.length) return list;
  const legacy = asString(rec.alert_webhook).trim();
  if (!legacy) return [];
  return [
    {
      id: LEGACY_WEBHOOK_ID,
      url: legacy,
      secret: asString(rec.alert_webhook_secret),
      format: "json",
      events: [...WEBHOOK_EVENTS],
    },
  ];
}

export function normalizeJev(raw: unknown): JevSettings {
  const rec = asRecord(raw) ?? {};
  return {
    enabled: asBool(rec.enabled, false),
    model: asString(rec.model).trim() || DEFAULT_JEV_MODEL,
    api_key: asString(rec.api_key),
  };
}

export function normalizeSemanticCache(raw: unknown): SemanticCacheSettings {
  const rec = asRecord(raw) ?? {};
  const model = modelAlias(asString(rec.model).trim());
  const threshold = asNumber(rec.threshold, SEMANTIC_THRESHOLD_DEFAULT);
  return {
    enabled: asBool(rec.enabled, false) && Boolean(model),
    model,
    threshold: Math.min(1, Math.max(SEMANTIC_THRESHOLD_MIN, threshold)),
  };
}

export function normalizeVectorDefaults(raw: unknown): VectorStoreDefaults {
  const rec = asRecord(raw) ?? {};
  const dimensions = Math.trunc(asNumber(rec.embedding_dimensions, 0));
  return {
    embedding_model: modelAlias(asString(rec.embedding_model)),
    embedding_dimensions: dimensions > 0 ? dimensions : 0,
    ocr_model: modelAlias(asString(rec.ocr_model)),
    rerank_model: modelAlias(asString(rec.rerank_model)),
  };
}

export function catalogConfidence(value: unknown): number {
  const confidence = asNumber(value, DEFAULT_AUTO_CONFIDENCE);
  return Math.min(1, Math.max(JEV_SUGGEST_CONFIDENCE, confidence));
}

export function catalogRouting(enterprise: Enterprise): CatalogRouting {
  return {
    autoRoutes: enterprise.catalog_auto_routes ?? true,
    minConfidence: catalogConfidence(enterprise.catalog_min_confidence),
  };
}

export function normalizeEnterprise(raw: unknown): Enterprise {
  const rec = asRecord(raw) ?? {};
  return {
    cache_ttl_seconds: asNumber(rec.cache_ttl_seconds, 0),
    cache_semantic: normalizeSemanticCache(rec.cache_semantic),
    log_retention_days: asNumber(rec.log_retention_days, 0),
    spend_retention_days: asNumber(rec.spend_retention_days, 0),
    audit_retention_days: asNumber(rec.audit_retention_days, 0),
    object_retention_days: asNumber(rec.object_retention_days, 30),
    file_retention_days: asNumber(rec.file_retention_days, 0),
    content_retention_days: asNumber(rec.content_retention_days, 0),
    alert_webhooks: normalizeWebhooks(rec),
    log_archive: asBool(rec.log_archive, false),
    log_content: asBool(rec.log_content, true),
    registration_enabled: asBool(rec.registration_enabled, false),
    assistant_model: modelAlias(asString(rec.assistant_model)),
    assistant_model_locked: asBool(rec.assistant_model_locked, false),
    catalog_jev: normalizeJev(rec.catalog_jev),
    catalog_auto_routes: asBool(rec.catalog_auto_routes, true),
    catalog_min_confidence: catalogConfidence(rec.catalog_min_confidence),
    update_check: asBool(rec.update_check, true),
    vector_stores: normalizeVectorDefaults(rec.vector_stores),
    oidc: normalizeOidc(rec.oidc),
    pii: normalizePii(rec.pii ?? DEFAULT_PII),
    s3: normalizeS3(rec.s3),
    budget_alert_thresholds: (() => {
      const list = asNumberArray(rec.budget_alert_thresholds);
      return list.length ? list : [50, 80, 100];
    })(),
    spend_anomaly_factor: anomalyFactor(asNumber(rec.spend_anomaly_factor, DEFAULT_SPEND_ANOMALY_FACTOR)),
    spend_anomaly_min_cost: Math.max(0, asNumber(rec.spend_anomaly_min_cost, DEFAULT_SPEND_ANOMALY_MIN_COST)),
    key_expiry_warning_days: Math.max(
      0,
      Math.trunc(asNumber(rec.key_expiry_warning_days, DEFAULT_KEY_EXPIRY_WARNING_DAYS)),
    ),
  };
}

export function normalizeOidc(raw: unknown): OIDCConfig {
  const rec = asRecord(raw) ?? {};
  return {
    enabled: asBool(rec.enabled, false),
    issuer: asString(rec.issuer),
    client_id: asString(rec.client_id),
    redirect_url: asString(rec.redirect_url),
  };
}

function normalizeS3(raw: unknown): S3Settings {
  const rec = asRecord(raw) ?? {};
  const addressingRaw = asString(rec.addressing, "auto");
  const addressing: S3Addressing =
    addressingRaw === "path" || addressingRaw === "virtual-hosted"
      ? addressingRaw
      : "auto";
  return {
    enabled: asBool(rec.enabled, false),
    bucket: asString(rec.bucket),
    region: asString(rec.region, "us-east-1"),
    endpoint: asString(rec.endpoint),
    prefix: asString(rec.prefix),
    addressing,
    public_base_url: asString(rec.public_base_url),
    domain_bucket: asBool(rec.domain_bucket, false),
  };
}

async function readJson(key: string): Promise<unknown | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  if (!row) return null;
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    return null;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value);
  await prisma.setting.upsert({
    where: { key },
    update: { value: serialized },
    create: { key, value: serialized },
  });
}

export async function getEnterprise(): Promise<Enterprise> {
  const raw = await readJson(SETTING_ENTERPRISE);
  const enterprise = normalizeEnterprise({ ...DEFAULT_ENTERPRISE, ...(asRecord(raw) ?? {}) });
  const jev = enterprise.catalog_jev ?? DEFAULT_JEV;
  return {
    ...enterprise,
    alert_webhooks: (enterprise.alert_webhooks ?? []).map((hook) => ({ ...hook, secret: open(hook.secret) })),
    catalog_jev: { ...jev, api_key: open(jev.api_key) },
  };
}

export async function getPii(): Promise<PiiPolicy> {
  return normalizePii((await getEnterprise()).pii);
}

export function piiOverride(raw: unknown): PiiPolicy | null {
  return asRecord(raw) ? normalizePii(raw) : null;
}

export async function resolvePii(principal: Principal): Promise<PiiPolicy> {
  if (principal.key?.pii) return principal.key.pii;
  const org = principal.orgId
    ? await prisma.organization.findUnique({
        where: { id: principal.orgId },
        select: { piiPolicy: true },
      })
    : null;
  return piiOverride(org?.piiPolicy) ?? getPii();
}

export async function getAlertState(kind: AlertStateKind): Promise<Record<string, string>> {
  return asStringMap(await readJson(ALERT_STATE_SETTINGS[kind]));
}

export async function saveAlertState(kind: AlertStateKind, state: Record<string, string>): Promise<void> {
  await writeJson(ALERT_STATE_SETTINGS[kind], state);
}

export async function patchEnterprise(patch: Partial<Enterprise>): Promise<Enterprise> {
  const current = await getEnterprise();
  const next: Enterprise = {
    ...current,
    ...patch,
    oidc: patch.oidc ? { ...current.oidc, ...patch.oidc } : current.oidc,
    pii: patch.pii ? { ...current.pii, ...patch.pii } : current.pii,
    s3: patch.s3 ? { ...current.s3, ...patch.s3 } : current.s3,
    catalog_jev: patch.catalog_jev ? { ...current.catalog_jev, ...patch.catalog_jev } : current.catalog_jev,
    vector_stores: patch.vector_stores
      ? normalizeVectorDefaults({ ...current.vector_stores, ...patch.vector_stores })
      : current.vector_stores,
  };
  const jev = next.catalog_jev ?? DEFAULT_JEV;
  await writeJson(SETTING_ENTERPRISE, {
    ...next,
    alert_webhooks: (next.alert_webhooks ?? []).map((hook) => ({ ...hook, secret: seal(hook.secret) })),
    catalog_jev: { ...jev, api_key: seal(jev.api_key) },
  });
  return next;
}

export async function savePii(pii: PIIConfig): Promise<PiiPolicy> {
  const normalized = normalizePii(pii);
  await patchEnterprise({ pii: normalized });
  return normalized;
}

export async function loadSettings() {
  const enterprise = await getEnterprise();
  return {
    cacheTtlSeconds: enterprise.cache_ttl_seconds ?? 0,
    semanticCache: normalizeSemanticCache(enterprise.cache_semantic),
  };
}
