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
import { WEBHOOK_EVENTS } from "@/lib/gateway/webhook-events";
import type {
  AlertWebhook,
  JsonMap,
  PIIConfig,
  OIDCConfig,
  S3Addressing,
  S3Settings,
  Enterprise,
  Principal,
} from "@/types/gateway";
import type { PiiPolicy } from "@/types/guardrails";

const SETTING_ENTERPRISE = "enterprise";
const SETTING_BUDGET_ALERTS = "budget_alert_state";
const LEGACY_WEBHOOK_ID = "legacy";

const DEFAULT_PII: PIIConfig = {
  enabled: true,
  mode: "mask",
  output: true,
  entities: [],
};

const DEFAULT_ENTERPRISE: Enterprise = {
  cache_ttl_seconds: 0,
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
  pii: DEFAULT_PII,
  budget_alert_thresholds: [50, 80, 100],
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

function normalizeWebhooks(rec: JsonMap): AlertWebhook[] {
  const list = (Array.isArray(rec.alert_webhooks) ? rec.alert_webhooks : []).flatMap((entry) => {
    const hook = asRecord(entry);
    const id = asString(hook?.id);
    const url = asString(hook?.url).trim();
    if (!hook || !id || !url) return [];
    const events = asStringArray(hook.events);
    return [{ id, url, secret: asString(hook.secret), events: WEBHOOK_EVENTS.filter((e) => events.includes(e)) }];
  });
  if (list.length) return list;
  const legacy = asString(rec.alert_webhook).trim();
  if (!legacy) return [];
  return [
    {
      id: LEGACY_WEBHOOK_ID,
      url: legacy,
      secret: asString(rec.alert_webhook_secret),
      events: [...WEBHOOK_EVENTS],
    },
  ];
}

export function normalizeEnterprise(raw: unknown): Enterprise {
  const rec = asRecord(raw) ?? {};
  return {
    cache_ttl_seconds: asNumber(rec.cache_ttl_seconds, 0),
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
    oidc: normalizeOidc(rec.oidc),
    pii: normalizePii(rec.pii ?? DEFAULT_PII),
    s3: normalizeS3(rec.s3),
    budget_alert_thresholds: (() => {
      const list = asNumberArray(rec.budget_alert_thresholds);
      return list.length ? list : [50, 80, 100];
    })(),
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
  return {
    ...enterprise,
    alert_webhooks: (enterprise.alert_webhooks ?? []).map((hook) => ({ ...hook, secret: open(hook.secret) })),
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

export async function getBudgetAlertState(): Promise<Record<string, string>> {
  return asStringMap(await readJson(SETTING_BUDGET_ALERTS));
}

export async function saveBudgetAlertState(state: Record<string, string>): Promise<void> {
  await writeJson(SETTING_BUDGET_ALERTS, state);
}

export async function patchEnterprise(patch: Partial<Enterprise>): Promise<Enterprise> {
  const current = await getEnterprise();
  const next: Enterprise = {
    ...current,
    ...patch,
    oidc: patch.oidc ? { ...current.oidc, ...patch.oidc } : current.oidc,
    pii: patch.pii ? { ...current.pii, ...patch.pii } : current.pii,
    s3: patch.s3 ? { ...current.s3, ...patch.s3 } : current.s3,
  };
  await writeJson(SETTING_ENTERPRISE, {
    ...next,
    alert_webhooks: (next.alert_webhooks ?? []).map((hook) => ({ ...hook, secret: seal(hook.secret) })),
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
  };
}
