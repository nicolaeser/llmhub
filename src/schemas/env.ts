import { z } from "zod";

function emptyToUndefined(v: unknown): unknown {
  return typeof v === "string" && v.trim() === "" ? undefined : v;
}

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v : undefined));

const optionalTrimmedString = z
  .string()
  .optional()
  .transform((v) => v?.trim() || undefined);

const IP_MODES = ["proxy", "cloudflare", "direct"] as const;

const optionalHttpUrl = optionalTrimmedString.refine(
  (v) => v === undefined || (URL.canParse(v) && /^https?:$/.test(new URL(v).protocol)),
  "must be an http or https URL",
);

const optionalSampleRate = optionalTrimmedString.refine(
  (v) => v === undefined || (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 1),
  "must be a number from 0 to 1",
);

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production"]),
  DATABASE_URL: z.string().min(1),
  APP_SECRET: z.string().min(32),
  NEXT_PUBLIC_APP_URL: z.preprocess(
    emptyToUndefined,
    z.string().default("http://localhost:3000"),
  ),
  S3_ACCESS_KEY_ID: optionalString,
  S3_SECRET_ACCESS_KEY: optionalString,
  SMTP_URL: optionalString,
  SMTP_FROM: optionalString,
  OIDC_CLIENT_SECRET: optionalString,
  REDIS_URL: optionalTrimmedString,
  IP_MODE: z.preprocess(
    (v) => (typeof v === "string" ? v.trim() || undefined : v),
    z.enum(IP_MODES).default("proxy"),
  ),
  BUILD_ID: optionalString,
  LLMHUB_REDACTOR_URL: optionalHttpUrl,
  SENTRY_DSN: optionalHttpUrl,
  NEXT_PUBLIC_SENTRY_DSN: optionalHttpUrl,
  SENTRY_AUTH_TOKEN: optionalString,
  SENTRY_ORG: optionalTrimmedString,
  SENTRY_PROJECT: optionalTrimmedString,
  SENTRY_ENVIRONMENT: optionalTrimmedString,
  SENTRY_RELEASE: optionalTrimmedString,
  SENTRY_TRACES_SAMPLE_RATE: optionalSampleRate,
});
