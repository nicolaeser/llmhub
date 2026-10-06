import { z } from "zod";
import { DATA_REGIONS } from "@/lib/gateway/model-policy";

export const providerPolicySchema = z.object({
  zdr: z.boolean().default(false),
  retentionDays: z.number().int().min(0).max(3650).nullable().default(null),
  region: z.union([z.enum(DATA_REGIONS), z.literal("")]).default(""),
  noTraining: z.boolean().default(false),
});
