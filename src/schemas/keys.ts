import { isIP } from "node:net";
import { z } from "zod";

const keyFields = {
  alias: z.string().trim().min(1).max(80),
  projectId: z.string().trim().max(64).default(""),
  memberId: z.string().trim().max(64).default(""),
  models: z.array(z.string().trim().min(1).max(200)).max(500).default([]),
  templateIds: z.array(z.string().trim().min(1).max(64)).max(50).default([]),
  rpm: z.number().int().min(0).max(1_000_000).default(0),
  tpm: z.number().int().min(0).max(1_000_000_000).default(0),
  allowedIps: z
    .array(z.string().trim().refine((ip) => isIP(ip) !== 0, "invalid IP address"))
    .max(100)
    .default([]),
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
