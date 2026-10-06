import { z } from "zod";

function emptyToUndefined(v: unknown): unknown {
  return typeof v === "string" && v.trim() === "" ? undefined : v;
}

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v : undefined));

export const envSchema = z.object({
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
  REDIS_URL: optionalString,
  BUILD_ID: optionalString,
});
