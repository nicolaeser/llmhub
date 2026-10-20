import { isResetKind } from "@/lib/gateway/routing/auto-reset-policy";
import { logger } from "@/lib/logging/logger";
import { parseJsonOrNull } from "@/lib/utils/json";
import { resetStateSchema } from "@/schemas/resets";
import type { SubscriptionLimits } from "@/types/providers";
import type { PendingClaim, PendingResetView, ResetCredits, ResetState } from "@/types/resets";

export const RETRY_WINDOW_MS = 10 * 60_000;
export const RESET_STATE_PREFIX = "provider_reset:";

export function resetStateKey(providerId: string): string {
  return `${RESET_STATE_PREFIX}${providerId}`;
}

export function parseResetState(value: string | undefined, providerId: string): ResetState {
  const parsed = resetStateSchema.safeParse(value ? parseJsonOrNull(value) : {});
  if (parsed.success) return parsed.data;
  logger.error("provider.reset_state_invalid", { providerId });
  return { pending: null, lastAutoAt: 0 };
}

export function pendingView(pending: PendingClaim, now: number): PendingResetView {
  const retryUntil = pending.startedAt + RETRY_WINDOW_MS;
  return {
    startedAt: new Date(pending.startedAt).toISOString(),
    retryUntil: new Date(retryUntil).toISOString(),
    retryable: now <= retryUntil,
  };
}

export function resetCreditsView(
  kind: string,
  limits: SubscriptionLimits,
  stored: ResetCredits | null,
  state: ResetState | null,
  now: number,
): ResetCredits | null {
  if (!isResetKind(kind)) return limits.resetCredits;
  const fromUsage = kind === "codex" ? limits.resetCredits : null;
  const base: ResetCredits | null = fromUsage
    ? {
        ...stored,
        available: fromUsage.available,
        applicable: fromUsage.applicable,
        checkedAt: limits.fetchedAt,
      }
    : stored;
  const pending = state?.pending ? pendingView(state.pending, now) : null;
  if (!base && !pending) return null;
  const credits = base ?? { available: 0, applicable: 0, checkedAt: null };
  return { ...credits, pending, canRedeem: pending ? pending.retryable : credits.applicable > 0 };
}
