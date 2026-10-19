import { z } from "zod";

export const RESET_KINDS = ["codex", "claude"] as const;
export const AUTO_RESET_SCOPES = ["pool", "account"] as const;
export const AUTO_RESET_PERCENT_MIN = 50;
export const AUTO_RESET_PERCENT_MAX = 100;
export const AUTO_RESET_PERCENT_DEFAULT = 99;
export const DEFAULT_AUTO_RESET_SCOPE = "pool";

export const CLAUDE_GRANT_ID = /^[a-z0-9_-]{1,40}$/;
export const CLAUDE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const ORG_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const pendingClaimSchema = z.object({
  kind: z.enum(RESET_KINDS),
  requestId: z.string().regex(CLAUDE_REQUEST_ID),
  creditId: z.string().min(1).max(200).optional(),
  grantId: z.string().regex(CLAUDE_GRANT_ID).optional(),
  orgUuid: z.string().regex(ORG_UUID).optional(),
  startedAt: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
  trigger: z.enum(["manual", "auto"]),
  actor: z.string().max(200),
});

export const resetStateSchema = z.object({
  pending: pendingClaimSchema.nullable().default(null),
  lastAutoAt: z.number().int().nonnegative().default(0),
});

export const autoResetInputSchema = z.object({
  kind: z.enum(RESET_KINDS),
  enabled: z.boolean(),
  percent: z.number().int().min(AUTO_RESET_PERCENT_MIN).max(AUTO_RESET_PERCENT_MAX),
  scope: z.enum(AUTO_RESET_SCOPES),
});
