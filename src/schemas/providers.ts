import { z } from "zod";
import { DATA_REGIONS } from "@/lib/gateway/model-policy";

export const providerPolicySchema = z.object({
  zdr: z.boolean().default(false),
  retentionDays: z.number().int().min(0).max(3650).nullable().default(null),
  region: z.union([z.enum(DATA_REGIONS), z.literal("")]).default(""),
  noTraining: z.boolean().default(false),
});

const signInKindSchema = z.enum(["codex", "grok_build"]);

const signInSessionSchema = z.object({
  tokens: z.object({
    access: z.string().min(1),
    refresh: z.string().min(1),
    accountId: z.string(),
    residency: z.string(),
  }),
  expiresAt: z.number(),
  account: z.string(),
  plan: z.string(),
});

export const signInTicketSchema = z.object({
  purpose: z.literal("sign_in_device"),
  uid: z.string().min(1),
  exp: z.number(),
  interval: z.number().int().positive(),
  grant: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("codex"), deviceAuthId: z.string().min(1), userCode: z.string().min(1) }),
    z.object({ kind: z.literal("grok_build"), deviceCode: z.string().min(1) }),
  ]),
});

export const signInCredentialSchema = z.object({
  purpose: z.literal("sign_in_credential"),
  uid: z.string().min(1),
  kind: signInKindSchema,
  exp: z.number(),
  session: signInSessionSchema,
});
