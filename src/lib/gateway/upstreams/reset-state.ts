import { isResetKind } from "@/lib/gateway/routing/auto-reset-policy";
import { limitsUpdatedAt } from "@/lib/gateway/upstreams/observed-limits";
import { claudeResetCredits } from "@/lib/gateway/upstreams/reset-credits";
import { codexResetOptions, pendingOptions } from "@/lib/gateway/upstreams/reset-options";
import { logger } from "@/lib/logging/logger";
import { parseJsonOrNull } from "@/lib/utils/json";
import { resetStateSchema } from "@/schemas/resets";
import type { SubscriptionLimits } from "@/types/providers";
import type { PendingClaim, PendingResetView, ResetCredits, ResetState, StoredResetView } from "@/types/resets";

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

function publicView(stored: StoredResetView): ResetCredits {
  const view: StoredResetView = { ...stored };
  delete view.claude;
  return view;
}

function claudeView(limits: SubscriptionLimits, stored: StoredResetView | null, now: number): ResetCredits | null {
  if (!stored) return null;
  const view = publicView(stored);
  const block = stored.claude;
  if (!block) return view;
  const readAt = view.checkedAt ? Date.parse(view.checkedAt) : NaN;
  const blockIsNewer = block.windows.length > 0 && Number.isFinite(readAt) && readAt >= limitsUpdatedAt(limits);
  const windows = blockIsNewer ? block.windows : limits.windows;
  return { ...view, ...claudeResetCredits(block, now, windows, { exhaustedIsCurrent: blockIsNewer }) };
}

function codexView(limits: SubscriptionLimits, stored: StoredResetView | null, now: number): ResetCredits | null {
  const fromUsage = limits.resetCredits;
  if (!fromUsage) return stored ? publicView(stored) : null;
  const credits = (stored?.credits ?? []).filter((credit) => credit.expiresAt === null || Date.parse(credit.expiresAt) > now);
  return {
    ...(stored ? publicView(stored) : {}),
    available: fromUsage.available,
    applicable: fromUsage.applicable,
    checkedAt: limits.fetchedAt,
    ...(stored?.credits ? { credits, ...codexResetOptions(fromUsage.applicable, credits, limits.windows, now) } : {}),
  };
}

export function resetCreditsView(
  kind: string,
  limits: SubscriptionLimits,
  stored: StoredResetView | null,
  state: ResetState | null,
  now: number,
): ResetCredits | null {
  if (!isResetKind(kind)) return limits.resetCredits;
  const base = kind === "codex" ? codexView(limits, stored, now) : claudeView(limits, stored, now);
  const pending = state?.pending ? pendingView(state.pending, now) : null;
  if (!base && !pending) return null;
  const credits = base ?? { available: 0, applicable: 0, checkedAt: null };
  return {
    ...credits,
    ...(pending && credits.options ? { options: pendingOptions(credits.options) } : {}),
    pending,
    canRedeem: pending ? pending.retryable : credits.applicable > 0,
  };
}
