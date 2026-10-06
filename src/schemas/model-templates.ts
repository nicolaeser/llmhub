import { z } from "zod";
import { DATA_REGIONS } from "@/lib/gateway/model-policy";

const templateFields = {
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).default(""),
  models: z.array(z.string().trim().min(1).max(200)).max(500).default([]),
  patterns: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  providerIds: z.array(z.string().trim().min(1).max(64)).max(100).default([]),
  regions: z.array(z.enum(DATA_REGIONS)).max(DATA_REGIONS.length).default([]),
  zdrOnly: z.boolean().default(false),
  noTrainingOnly: z.boolean().default(false),
  maxRetentionDays: z.number().int().min(0).max(3650).nullable().default(null),
};

export const createTemplateSchema = z.object(templateFields);

export const updateTemplateSchema = z.object({
  ...templateFields,
  id: z.string().min(1).max(64),
});
