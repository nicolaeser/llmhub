import { z } from "zod";
import { DATA_REGIONS } from "@/lib/gateway/access/model-policy";

export const providerPolicySchema = z.object({
  zdr: z.boolean().default(false),
  retentionDays: z.number().int().min(0).max(3650).nullable().default(null),
  region: z.union([z.enum(DATA_REGIONS), z.literal("")]).default(""),
  noTraining: z.boolean().default(false),
});

export const vertexTargetSchema = z
  .object({
    project: z.string().trim().max(100).optional(),
    location: z.string().trim().max(64).optional(),
  })
  .strict();

export const MAX_AUTH_FILES = 50;
export const MAX_AUTH_FILE_BYTES = 256 * 1024;

const signInKindSchema = z.enum(["codex", "grok_build", "claude", "antigravity", "kimi", "kimi_ai", "muse_code", "devin"]);

const authFileUploadSchema = z.object({
  name: z.string().trim().min(1).max(255),
  content: z.string().max(MAX_AUTH_FILE_BYTES),
});

export const authFileImportSchema = z.array(authFileUploadSchema).min(1).max(MAX_AUTH_FILES);

export const cliProxyConnectionSchema = z.object({
  url: z.string().trim().min(1).max(2048),
  key: z.string().trim().min(1).max(512),
});

export const cliProxyImportSchema = cliProxyConnectionSchema.extend({
  names: z.array(z.string().trim().min(1).max(255)).min(1).max(MAX_AUTH_FILES),
  removeFromSource: z.boolean(),
});

export const signInFileSchema = z.object({
  kind: signInKindSchema,
  content: z.string().min(1).max(MAX_AUTH_FILE_BYTES),
});

const signInSessionSchema = z.object({
  tokens: z.object({
    access: z.string().min(1),
    refresh: z.string().min(1),
    accountId: z.string(),
    residency: z.string(),
    device: z.string().optional(),
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
    z.object({ kind: z.literal("claude"), verifier: z.string().min(1), state: z.string().min(1) }),
    z.object({ kind: z.literal("antigravity"), verifier: z.string().min(1), state: z.string().min(1) }),
    z.object({ kind: z.literal("kimi"), deviceCode: z.string().min(1), device: z.string().min(1) }),
    z.object({ kind: z.literal("kimi_ai"), deviceCode: z.string().min(1), device: z.string().min(1) }),
    z.object({ kind: z.literal("muse_code"), deviceCode: z.string().min(1) }),
    z.object({ kind: z.literal("devin"), verifier: z.string().min(1), state: z.string().min(1) }),
  ]),
});

export const signInCredentialSchema = z.object({
  purpose: z.literal("sign_in_credential"),
  uid: z.string().min(1),
  kind: signInKindSchema,
  exp: z.number(),
  session: signInSessionSchema,
});
