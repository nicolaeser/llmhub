import { isIP } from "node:net";
import { z } from "zod";
import { modelAlias } from "@/lib/gateway/model-alias";
import { KEY_ENDPOINTS, MAX_ACCESS_WINDOWS } from "@/lib/gateway/key-restrictions";
import { clockMinute, isTimeZone, WEEKDAYS } from "@/lib/gateway/price-schedule";

const clock = z.string().refine((value) => clockMinute(value) !== null, "expected HH:MM");

export const accessWindowSchema = z
  .object({
    days: z
      .array(z.enum(WEEKDAYS))
      .min(1)
      .max(WEEKDAYS.length)
      .transform((days) => WEEKDAYS.filter((day) => days.includes(day))),
    start: clock,
    end: clock,
  })
  .strict();

export const accessWindowsSchema = z.array(accessWindowSchema).max(MAX_ACCESS_WINDOWS);

export const allowedEndpointsSchema = z
  .array(z.enum(KEY_ENDPOINTS))
  .max(KEY_ENDPOINTS.length)
  .transform((endpoints) => KEY_ENDPOINTS.filter((endpoint) => endpoints.includes(endpoint)));

export const accessTimeZoneSchema = z.string().trim().max(64).refine(isTimeZone, "unknown IANA time zone");

const keyFields = {
  alias: z.string().trim().min(1).max(80),
  projectId: z.string().trim().max(64).default(""),
  memberId: z.string().trim().max(64).default(""),
  models: z.array(z.string().trim().min(1).max(200).transform(modelAlias)).max(500).default([]),
  templateIds: z.array(z.string().trim().min(1).max(64)).max(50).default([]),
  rpm: z.number().int().min(0).max(1_000_000).default(0),
  tpm: z.number().int().min(0).max(1_000_000_000).default(0),
  allowedIps: z
    .array(z.string().trim().refine((ip) => isIP(ip) !== 0, "invalid IP address"))
    .max(100)
    .default([]),
  allowedEndpoints: allowedEndpointsSchema.default([]),
  accessWindows: accessWindowsSchema.default([]),
  accessTimeZone: accessTimeZoneSchema.default("UTC"),
  logContent: z.boolean().default(true),
};

export const createKeySchema = z.object({
  ...keyFields,
  days: z.number().int().min(0).max(3650).default(0),
});

export const updateKeySchema = z.object({
  ...keyFields,
  id: z.string().min(1).max(64),
  blocked: z.boolean(),
});
