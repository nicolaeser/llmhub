import { z } from "zod";
import { ASSIGNMENT_SCOPES } from "@/lib/gateway/routing/account-access";
import { SUB_ADD_TOKEN_PATTERN } from "@/lib/http/public-path";

export const SUB_ADD_DEFAULT_DAYS = 7;
export const SUB_ADD_MAX_DAYS = 90;
export const SUB_ADD_MAX_ACCOUNTS = 100;
export const SUB_ADD_LABEL_MAX = 80;
export const SUB_ADD_MAX_TARGETS = 500;

const kindSchema = z.string().trim().min(1).max(40);

const subAddTokenSchema = z.string().regex(SUB_ADD_TOKEN_PATTERN);

const ticketSchema = z.string().min(1).max(16_384);

export const subAddLinkInputSchema = z.object({
  label: z.string().trim().min(1).max(SUB_ADD_LABEL_MAX),
  kinds: z.array(kindSchema).min(1).max(20),
  days: z.number().int().min(1).max(SUB_ADD_MAX_DAYS),
  maxAccounts: z.number().int().min(1).max(SUB_ADD_MAX_ACCOUNTS).nullable(),
  restricted: z.boolean(),
  manageable: z.boolean().default(true),
  targets: z
    .array(z.object({ scope: z.enum(ASSIGNMENT_SCOPES), id: z.string().trim().min(1).max(64) }))
    .max(SUB_ADD_MAX_TARGETS),
});

export const subAddLinkCreateSchema = subAddLinkInputSchema.extend({ code: z.string().trim().min(1).max(64) });

export const subAddOpenSchema = z.object({ token: subAddTokenSchema });

export const subAddStartSchema = z.object({ token: subAddTokenSchema, kind: kindSchema });

export const subAddPollSchema = z.object({
  token: subAddTokenSchema,
  ticket: ticketSchema,
  interval: z.number().min(0).max(600),
  manage: subAddTokenSchema.optional(),
});

export const subAddCompleteSchema = z.object({
  token: subAddTokenSchema,
  ticket: ticketSchema,
  code: z.string().trim().min(1).max(4096),
  manage: subAddTokenSchema.optional(),
});

export const subAddManageSchema = z.object({ manage: subAddTokenSchema });

export const subAddRemoveSchema = z.object({ manage: subAddTokenSchema, providerId: z.string().min(1).max(64) });
