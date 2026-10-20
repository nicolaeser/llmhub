import type { z } from "zod";
import type { autoResetInputSchema, resetStateSchema } from "@/schemas/resets";
import type { LimitSnapshot, SubscriptionLimits } from "@/types/providers";

export type ResetKind = "codex" | "claude";

export type ClaudeResetGrant = {
  id: string;
  label: string;
  resetsTotal: number;
  resetsLeft: number;
  startsAt: string | null;
  endsAt: string | null;
  clears: string[];
  paused: boolean;
  usableNow: boolean;
  useRequiresLimit: boolean;
  percentUsed: Record<string, number>;
};

export type ClaudeIneligibleReason =
  | "config_off"
  | "tier"
  | "seat"
  | "mobile"
  | "surface"
  | "cli_version"
  | "no_grant"
  | "tenure"
  | "other_experiment"
  | "unavailable"
  | "unknown";

export type ClaudeResetBlock = {
  eligible: boolean;
  ineligibleReason: ClaudeIneligibleReason | null;
  atLimit: boolean;
  grants: ClaudeResetGrant[];
  nextGrantId: string;
  weeklyResetsAt: string | null;
  cooldownUntil: string | null;
};

export type CodexResetCreditStatus = "available" | "redeeming" | "redeemed";

export type CodexResetCredit = {
  id: string;
  status: CodexResetCreditStatus;
  grantedAt: string | null;
  expiresAt: string | null;
  title: string;
  description: string;
};

export type CodexCreditList = {
  credits: CodexResetCredit[];
  availableCount: number;
  totalEarnedCount: number;
  purchaseEligible: boolean;
};

export type ResetGrantView = {
  id: string;
  label: string;
  resetsLeft: number;
  resetsTotal: number;
  endsAt: string | null;
  clears: string[];
  usable: boolean;
};

export type ResetCreditView = {
  id: string;
  title: string;
  expiresAt: string | null;
};

export type PendingResetView = {
  startedAt: string;
  retryUntil: string;
  retryable: boolean;
};

export type ResetCredits = {
  available: number;
  applicable: number;
  expiresAt?: string | null;
  credits?: ResetCreditView[];
  grants?: ResetGrantView[];
  eligible?: boolean;
  ineligibleReason?: ClaudeIneligibleReason | null;
  atLimit?: boolean;
  cooldownUntil?: string | null;
  canRedeem?: boolean;
  pending?: PendingResetView | null;
  checkedAt?: string | null;
};

export type CodexRedeemResult = "reset" | "already_redeemed" | "nothing_to_reset" | "no_credit";

export type ClaudeRedeemResult = "reset" | "already_used" | "not_limited" | "cooldown" | "ineligible" | "unavailable";

export type ResetResult = CodexRedeemResult | ClaudeRedeemResult | "rate_limited" | "auth_error" | "unknown";

export type RedeemOutcome = {
  result: ResetResult;
  windowsReset: number;
};

export type ResetTrigger = "manual" | "auto";

export type ResetState = z.infer<typeof resetStateSchema>;

export type PendingClaim = NonNullable<ResetState["pending"]>;

export type ClaudeClaim = {
  orgUuid: string;
  grantId: string;
  requestId: string;
};

export type CodexClaim = {
  redeemRequestId: string;
  creditId?: string;
};

export type AutoResetScope = "account" | "pool";

export type AutoResetPolicy = {
  enabled: boolean;
  percent: number;
  scope: AutoResetScope;
};

export type AutoResetPolicies = Partial<Record<ResetKind, AutoResetPolicy>>;

export type AutoResetInput = z.infer<typeof autoResetInputSchema>;

export type AutoUsage = {
  id: string;
  usage: number | null;
  recovery: number;
};

export type AutoSkipReason =
  | "off"
  | "unsupported"
  | "no_accounts"
  | "below_threshold"
  | "pool_has_room"
  | "guard"
  | "pending"
  | "not_applicable"
  | "busy"
  | "error";

export type AutoResetOutcome =
  | { status: "redeemed"; providerId: string; result: ResetResult }
  | { status: "attempted"; providerId: string; result: ResetResult }
  | { status: "skipped"; reason: AutoSkipReason };

export type RedeemResponse = {
  result: ResetResult;
  windowsReset: number;
  limits: SubscriptionLimits | null;
  item: LimitSnapshot | null;
};

export type ResetProvider = {
  id: string;
  kind: string;
  apiKey: string;
};

export type StatusRead<T> = {
  status: number;
  value: T | null;
  retryAfterMs: number | null;
};
