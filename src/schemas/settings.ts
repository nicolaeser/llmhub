import { z } from "zod";
import { CACHE_STATS_RANGES, CACHE_TTL_MAX_SECONDS, SEMANTIC_THRESHOLD_MIN } from "@/lib/gateway/cache-settings";
import { modelAlias } from "@/lib/gateway/model-alias";
import { MAX_ALERT_WEBHOOKS, WEBHOOK_EVENTS, WEBHOOK_FORMATS } from "@/lib/gateway/webhook-events";

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

const text = z.string().trim().max(200);

export const adminSettingsSchema = z.object({
  registration_enabled: z.boolean(),
  assistant_model: text.transform(modelAlias),
  assistant_model_locked: z.boolean().default(false),
  update_check: z.boolean(),
  catalog_auto_routes: z.boolean(),
  catalog_min_confidence: z.number().min(0.5).max(1),
  catalog_jev: z.object({
    enabled: z.boolean(),
    model: z.string().trim().max(120).regex(/^[\w.~:/-]*$/),
    api_key: z.string().trim().max(500),
    clear_api_key: z.boolean(),
  }),
  oidc: z.object({
    enabled: z.boolean(),
    issuer: optionalUrl,
    client_id: text,
    redirect_url: optionalUrl,
  }),
  s3: z.object({
    enabled: z.boolean(),
    bucket: text,
    region: text,
    endpoint: optionalUrl,
    prefix: text,
    addressing: z.enum(["auto", "path", "virtual-hosted"]),
    public_base_url: optionalUrl,
    domain_bucket: z.boolean(),
  }),
});

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

export const cacheSettingsSchema = z.object({
  cacheTtlSeconds: z.number().int().min(0).max(CACHE_TTL_MAX_SECONDS).optional(),
  semantic: z
    .object({
      enabled: z.boolean(),
      model: text.transform(modelAlias),
      threshold: z.number().min(SEMANTIC_THRESHOLD_MIN).max(1),
    })
    .refine((semantic) => !semantic.enabled || Boolean(semantic.model), { path: ["model"] })
    .optional(),
});

export const cacheStatsSchema = z.object({
  days: z.union(CACHE_STATS_RANGES.map((days) => z.literal(days))),
});
