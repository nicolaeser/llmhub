import { z } from "zod";
import { CACHE_STATS_RANGES, CACHE_TTL_MAX_SECONDS, SEMANTIC_THRESHOLD_MIN } from "@/lib/gateway/cache/cache-settings";
import { modelAlias } from "@/lib/gateway/catalog/model-alias";
import { MAX_ALERT_WEBHOOKS, WEBHOOK_EVENTS, WEBHOOK_FORMATS } from "@/lib/alerts/events";
import { vectorDefaultsSchema } from "@/schemas/rag";
import { MAX_ALLOWED_DOMAINS, MAX_ROLE_MAPPINGS, OIDC_PROVIDER_IDS, trimIssuer } from "@/lib/auth/oidc-presets";
import { hasPlaceholder, S3_ADDRESSING, S3_PRESET_IDS } from "@/lib/s3/presets";

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

const optionalUrl = z
  .string()
  .trim()
  .max(500)
  .refine((value) => !value || isHttpUrl(value), "must be an http(s) URL");

const issuerUrl = optionalUrl.transform(trimIssuer);

const text = z.string().trim().max(200);

const roleId = z.string().trim().max(64);

const domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/);

export const generalSettingsSchema = z.object({
  registration_enabled: z.boolean(),
  update_check: z.boolean(),
});

export const oidcSettingsSchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(OIDC_PROVIDER_IDS),
  issuer: issuerUrl,
  client_id: text,
  scopes: z
    .string()
    .trim()
    .max(500)
    .regex(/^[\x21\x23-\x5B\x5D-\x7E ]*$/),
  groups_claim: z.string().trim().max(200),
  role_mappings: z
    .array(z.object({ group: z.string().trim().min(1).max(256), role_id: roleId.min(1) }))
    .max(MAX_ROLE_MAPPINGS),
  default_role_id: roleId,
  default_org_id: roleId,
  allowed_domains: z.array(domain).max(MAX_ALLOWED_DOMAINS),
  sso_only: z.boolean(),
});

export const storageSettingsSchema = z.object({
  preset: z.enum(S3_PRESET_IDS),
  bucket: z
    .string()
    .trim()
    .max(255)
    .regex(/^[A-Za-z0-9._-]*$/),
  region: z
    .string()
    .trim()
    .max(64)
    .regex(/^[A-Za-z0-9_-]*$/),
  endpoint: optionalUrl.refine((value) => !hasPlaceholder(value), "replace the placeholder"),
  prefix: text,
  addressing: z.enum(S3_ADDRESSING),
  public_base_url: optionalUrl,
});

export const catalogSettingsSchema = z.object({
  catalog_auto_routes: z.boolean(),
  catalog_min_confidence: z.number().min(0.5).max(1),
  catalog_jev: z.object({
    enabled: z.boolean(),
    model: z.string().trim().max(120).regex(/^[\w.~:/-]*$/),
    api_key: z.string().trim().max(500),
    clear_api_key: z.boolean(),
  }),
  vector_stores: vectorDefaultsSchema,
});

export const issuerCheckSchema = z.object({ issuer: issuerUrl.refine(Boolean) });

export const alertWebhooksSchema = z
  .array(
    z.object({
      id: z.string().trim().max(64).nullable(),
      url: z.string().trim().max(500).refine(isHttpUrl, "must be an http(s) URL"),
      secret: z.string().trim().max(500),
      clearSecret: z.boolean(),
      format: z.enum(WEBHOOK_FORMATS),
      events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
    }),
  )
  .max(MAX_ALERT_WEBHOOKS);

export const semanticCacheSchema = z
  .object({
    enabled: z.boolean(),
    model: text.transform(modelAlias),
    threshold: z.number().min(SEMANTIC_THRESHOLD_MIN).max(1),
  })
  .refine((semantic) => !semantic.enabled || Boolean(semantic.model), { path: ["model"] });

export const cacheSettingsSchema = z.object({
  cacheTtlSeconds: z.number().int().min(0).max(CACHE_TTL_MAX_SECONDS).optional(),
  semantic: semanticCacheSchema.optional(),
});

export const cacheStatsSchema = z.object({
  days: z.union(CACHE_STATS_RANGES.map((days) => z.literal(days))),
});
