import { z } from "zod";

export const piiPolicySchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(["mask", "block"]),
  output: z.boolean(),
  entities: z.array(z.string().trim().min(1).max(64)).max(100),
});

export const piiOverrideSchema = z.object({
  scope: z.enum(["org", "key"]),
  id: z.string().trim().min(1).max(64),
  policy: piiPolicySchema.nullable(),
});
