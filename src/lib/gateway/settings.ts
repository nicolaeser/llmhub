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
import {
  defaultGuardrails,
  GUARDRAIL_ACTIONS,
  INJECTION_CHECKS,
  MAX_RULE_PATTERNS,
  MAX_RULES,
  RULE_KINDS,
  RULE_TARGETS,
  SECRET_ENTITIES,
} from "@/lib/gateway/guardrails";
import { modelAlias } from "@/lib/gateway/model-alias";
import { DEFAULT_AUTO_CONFIDENCE, JEV_SUGGEST_CONFIDENCE } from "@/lib/gateway/model-catalog";
import { WEBHOOK_EVENTS } from "@/lib/gateway/webhook-events";
import type {
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
} from "@/types/gateway";
import type { GuardrailPolicy, GuardrailRule, PiiPolicy } from "@/types/guardrails";

const SETTING_ENTERPRISE = "enterprise";
const SETTING_BUDGET_ALERTS = "budget_alert_state";
const LEGACY_WEBHOOK_ID = "legacy";

const DEFAULT_PII: PIIConfig = {
  enabled: true,
  mode: "mask",
  output: true,
  entities: [],
};

export const DEFAULT_JEV_MODEL = "jev-latest";

const DEFAULT_JEV: JevSettings = { enabled: false, model: DEFAULT_JEV_MODEL, api_key: "" };

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
  catalog_jev: DEFAULT_JEV,
  catalog_auto_routes: true,
  catalog_min_confidence: DEFAULT_AUTO_CONFIDENCE,
  update_check: true,
  pii: DEFAULT_PII,
  guardrails: defaultGuardrails(),
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

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find((item) => item === value) ?? fallback;
}

function normalizeRule(raw: unknown, index: number): GuardrailRule[] {
  const rec = asRecord(raw);
  if (!rec) return [];
  const patterns = asStringArray(rec.patterns)
    .map((pattern) => pattern.trim())
    .filter(Boolean)
    .slice(0, MAX_RULE_PATTERNS);
  const name = asString(rec.name).trim();
  if (!patterns.length || !name) return [];
  return [
    {
      id: asString(rec.id).trim() || `rule_${index + 1}`,
      name,
      kind: pick(rec.kind, RULE_KINDS, "denylist"),
      target: pick(rec.target, RULE_TARGETS, "input"),
      action: pick(rec.action, GUARDRAIL_ACTIONS, "block"),
      patterns,
      caseSensitive: asBool(rec.caseSensitive, false),
    },
  ];
}

export function normalizeGuardrails(raw: unknown): GuardrailPolicy {
  const rec = asRecord(raw) ?? {};
  const fallback = defaultGuardrails();
  const injection = asRecord(rec.injection) ?? {};
  const secrets = asRecord(rec.secrets) ?? {};
  const checks = asStringArray(injection.checks);
  const entities = asStringArray(secrets.entities);
  return {
    injection: {
      enabled: asBool(injection.enabled, fallback.injection.enabled),
      action: pick(injection.action, ["block", "flag"] as const, fallback.injection.action),
      checks: Array.isArray(injection.checks)
        ? INJECTION_CHECKS.filter((check) => checks.includes(check))
        : fallback.injection.checks,
    },
    secrets: {
      enabled: asBool(secrets.enabled, fallback.secrets.enabled),
      action: pick(secrets.action, GUARDRAIL_ACTIONS, fallback.secrets.action),
      entities: Array.isArray(secrets.entities)
        ? SECRET_ENTITIES.filter((id) => entities.includes(id))
        : fallback.secrets.entities,
    },
    rules: (Array.isArray(rec.rules) ? rec.rules : []).slice(0, MAX_RULES).flatMap(normalizeRule),
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

export function normalizeJev(raw: unknown): JevSettings {
  const rec = asRecord(raw) ?? {};
  return {
    enabled: asBool(rec.enabled, false),
    model: asString(rec.model).trim() || DEFAULT_JEV_MODEL,
    api_key: asString(rec.api_key),
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
    oidc: normalizeOidc(rec.oidc),
    pii: normalizePii(rec.pii ?? DEFAULT_PII),
    guardrails: normalizeGuardrails(rec.guardrails),
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

export async function getGuardrails(): Promise<GuardrailPolicy> {
  return normalizeGuardrails((await getEnterprise()).guardrails);
}

export function guardrailOverride(raw: unknown): GuardrailPolicy | null {
  return asRecord(raw) ? normalizeGuardrails(raw) : null;
}

const POLICY_SELECT = { piiPolicy: true, guardrailPolicy: true } as const;

async function inheritedPolicies(principal: Principal) {
  const projectId = principal.key?.project_id;
  const [project, org] = await Promise.all([
    projectId ? prisma.project.findUnique({ where: { id: projectId }, select: POLICY_SELECT }) : null,
    principal.orgId ? prisma.organization.findUnique({ where: { id: principal.orgId }, select: POLICY_SELECT }) : null,
  ]);
  return { project, org };
}

export async function resolvePolicies(principal: Principal): Promise<{ pii: PiiPolicy; guardrails: GuardrailPolicy }> {
  const keyPii = principal.key?.pii ?? null;
  const keyGuardrails = principal.guardrails ?? null;
  const { project, org } =
    keyPii && keyGuardrails ? { project: null, org: null } : await inheritedPolicies(principal);
  const pii = keyPii ?? piiOverride(project?.piiPolicy) ?? piiOverride(org?.piiPolicy);
  const guardrails =
    keyGuardrails ?? guardrailOverride(project?.guardrailPolicy) ?? guardrailOverride(org?.guardrailPolicy);
  if (pii && guardrails) return { pii, guardrails };
  const enterprise = await getEnterprise();
  return {
    pii: pii ?? normalizePii(enterprise.pii),
    guardrails: guardrails ?? normalizeGuardrails(enterprise.guardrails),
  };
}

export async function resolvePii(principal: Principal): Promise<PiiPolicy> {
  return (await resolvePolicies(principal)).pii;
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
    catalog_jev: patch.catalog_jev ? { ...current.catalog_jev, ...patch.catalog_jev } : current.catalog_jev,
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

export async function saveGuardrails(policy: GuardrailPolicy): Promise<GuardrailPolicy> {
  const normalized = normalizeGuardrails(policy);
  await patchEnterprise({ guardrails: normalized });
  return normalized;
}

export async function loadSettings() {
  const enterprise = await getEnterprise();
  return {
    cacheTtlSeconds: enterprise.cache_ttl_seconds ?? 0,
  };
}
